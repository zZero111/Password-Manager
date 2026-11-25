import { argon2id } from "hash-wasm";
import { buf, fromBase64, randomBytes, toBase64, utf8 } from "./encoding";
import { KDF_MAX, KDF_MIN } from "./protocol";

/**
 * Key hierarchy
 *
 *   master password ──Argon2id(salt, kdf)──▶ master key (32 bytes, never stored)
 *        master key ──HKDF "pm-enc-v1"────▶ key-encryption key (wraps the vault key)
 *        master key ──HKDF "pm-auth-v1"───▶ auth key (sent to the server to log in;
 *                                           the server stores only a hash of it)
 *   vault key (random 32 bytes) ──AES-256-GCM──▶ every vault item
 *
 * The server only ever sees: email, salt, KDF params, a hash of the auth key,
 * the wrapped vault key and encrypted items. It cannot decrypt anything.
 */

export interface KdfParams {
  algorithm: "argon2id";
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

export const DEFAULT_KDF: KdfParams = {
  algorithm: "argon2id",
  memoryKiB: 64 * 1024,
  iterations: 3,
  parallelism: 4,
};

/**
 * Floor for KDF parameters. KDF params come back from the server at login, so a
 * malicious or compromised server could try to downgrade them to make offline
 * cracking cheap. The client refuses anything below the OWASP Argon2id minimum.
 */
export const MIN_KDF = KDF_MIN;
const MAX_KDF = KDF_MAX;

export class WrongPasswordError extends Error {
  constructor() {
    super("Incorrect master password");
    this.name = "WrongPasswordError";
  }
}

export class DecryptionError extends Error {
  constructor(message = "Data could not be decrypted (corrupted or tampered)") {
    super(message);
    this.name = "DecryptionError";
  }
}

export function validateKdf(kdf: KdfParams): void {
  if (kdf.algorithm !== "argon2id") throw new Error("Unsupported KDF algorithm");
  for (const k of ["memoryKiB", "iterations", "parallelism"] as const) {
    const v = kdf[k];
    if (!Number.isInteger(v) || v < MIN_KDF[k] || v > MAX_KDF[k]) {
      throw new Error(`KDF parameter ${k}=${v} is outside the allowed range`);
    }
  }
}

export function newSalt(): string {
  return toBase64(randomBytes(16));
}

export interface MasterKeys {
  /** Wraps / unwraps the vault key. Non-extractable. */
  kek: CryptoKey;
  /** Base64 proof of password knowledge, sent to the server. */
  authKey: string;
}

export async function deriveMasterKeys(
  password: string,
  salt: string,
  kdf: KdfParams,
): Promise<MasterKeys> {
  validateKdf(kdf);
  const master = await argon2id({
    password: utf8.encode(password.normalize("NFKC")),
    salt: fromBase64(salt),
    parallelism: kdf.parallelism,
    iterations: kdf.iterations,
    memorySize: kdf.memoryKiB,
    hashLength: 32,
    outputType: "binary",
  });
  const hkdfKey = await crypto.subtle.importKey("raw", buf(master), "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);
  master.fill(0);
  const hkdf = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(32),
    info: buf(utf8.encode(info)),
  });
  const kek = await crypto.subtle.deriveKey(
    hkdf("pm-enc-v1"),
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const auth = new Uint8Array(await crypto.subtle.deriveBits(hkdf("pm-auth-v1"), hkdfKey, 256));
  return { kek, authKey: toBase64(auth) };
}

const VERSION = "1";

/** Encrypt with AES-256-GCM. `aad` binds the ciphertext to its context (e.g. item id). */
export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buf(iv), additionalData: buf(utf8.encode(aad)) },
      key,
      buf(plaintext),
    ),
  );
  return `${VERSION}.${toBase64(iv)}.${toBase64(ct)}`;
}

export async function decryptBytes(key: CryptoKey, encoded: string, aad: string): Promise<Uint8Array> {
  const parts = encoded.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) throw new DecryptionError("Unknown ciphertext format");
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf(fromBase64(parts[1]!)), additionalData: buf(utf8.encode(aad)) },
      key,
      buf(fromBase64(parts[2]!)),
    );
    return new Uint8Array(pt);
  } catch {
    throw new DecryptionError();
  }
}

export async function encryptJson(key: CryptoKey, value: unknown, aad: string): Promise<string> {
  return encryptBytes(key, utf8.encode(JSON.stringify(value)), aad);
}

export async function decryptJson<T>(key: CryptoKey, encoded: string, aad: string): Promise<T> {
  return JSON.parse(utf8.decode(await decryptBytes(key, encoded, aad))) as T;
}

const VAULT_KEY_AAD = "pm-vault-key";

async function importVaultKey(raw: Uint8Array): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey("raw", buf(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  raw.fill(0);
  return key;
}

/** Create a fresh vault key, returning it and its wrapped (encrypted) form. */
export async function createVaultKey(kek: CryptoKey): Promise<{ vaultKey: CryptoKey; protectedKey: string }> {
  const raw = randomBytes(32);
  const protectedKey = await encryptBytes(kek, raw, VAULT_KEY_AAD);
  return { vaultKey: await importVaultKey(raw), protectedKey };
}

/** Unwrap the vault key. Fails with WrongPasswordError if the KEK is wrong. */
export async function unwrapVaultKey(kek: CryptoKey, protectedKey: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = await decryptBytes(kek, protectedKey, VAULT_KEY_AAD);
  } catch {
    throw new WrongPasswordError();
  }
  return importVaultKey(raw);
}

/** Re-wrap the vault key under a new KEK (used when changing the master password). */
export async function rewrapVaultKey(oldKek: CryptoKey, newKek: CryptoKey, protectedKey: string): Promise<string> {
  let raw: Uint8Array;
  try {
    raw = await decryptBytes(oldKek, protectedKey, VAULT_KEY_AAD);
  } catch {
    throw new WrongPasswordError();
  }
  const wrapped = await encryptBytes(newKek, raw, VAULT_KEY_AAD);
  raw.fill(0);
  return wrapped;
}

export const itemAad = (id: string) => `pm-item:${id}`;
