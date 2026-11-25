import { describe, expect, it } from "vitest";
import {
  DecryptionError,
  MIN_KDF,
  WrongPasswordError,
  createVaultKey,
  decryptJson,
  deriveMasterKeys,
  encryptJson,
  fromBase64,
  newSalt,
  rewrapVaultKey,
  toBase64,
  unwrapVaultKey,
  type KdfParams,
} from "../src";

const kdf: KdfParams = { algorithm: "argon2id", ...MIN_KDF };

describe("base64", () => {
  it("matches Node's encoder for all lengths", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      const expected = Buffer.from(bytes).toString("base64");
      expect(toBase64(bytes)).toBe(expected);
      expect([...fromBase64(expected)]).toEqual([...bytes]);
    }
  });
});

describe("key derivation", () => {
  it("is deterministic and password-sensitive", async () => {
    const salt = newSalt();
    const a = await deriveMasterKeys("correct horse", salt, kdf);
    const b = await deriveMasterKeys("correct horse", salt, kdf);
    const c = await deriveMasterKeys("correct horsf", salt, kdf);
    expect(a.authKey).toBe(b.authKey);
    expect(a.authKey).not.toBe(c.authKey);
    expect(fromBase64(a.authKey)).toHaveLength(32);
  });

  it("normalises unicode so the same password typed differently still works", async () => {
    const salt = newSalt();
    const composed = await deriveMasterKeys("café", salt, kdf);
    const decomposed = await deriveMasterKeys("café", salt, kdf);
    expect(composed.authKey).toBe(decomposed.authKey);
  });

  it("refuses KDF parameters below the security floor (server downgrade attack)", async () => {
    await expect(deriveMasterKeys("pw", newSalt(), { ...kdf, memoryKiB: 1024 })).rejects.toThrow(/outside/);
    await expect(deriveMasterKeys("pw", newSalt(), { ...kdf, iterations: 1 })).rejects.toThrow(/outside/);
  });
});

describe("vault key", () => {
  it("wraps and unwraps; wrong password is detected", async () => {
    const salt = newSalt();
    const right = await deriveMasterKeys("right", salt, kdf);
    const wrong = await deriveMasterKeys("wrong", salt, kdf);
    const { vaultKey, protectedKey } = await createVaultKey(right.kek);
    const ct = await encryptJson(vaultKey, { hello: "world" }, "ctx");
    const unwrapped = await unwrapVaultKey(right.kek, protectedKey);
    expect(await decryptJson(unwrapped, ct, "ctx")).toEqual({ hello: "world" });
    await expect(unwrapVaultKey(wrong.kek, protectedKey)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("rewrap keeps the same vault key under a new password", async () => {
    const s1 = newSalt();
    const s2 = newSalt();
    const old = await deriveMasterKeys("old", s1, kdf);
    const next = await deriveMasterKeys("new", s2, kdf);
    const { vaultKey, protectedKey } = await createVaultKey(old.kek);
    const ct = await encryptJson(vaultKey, [1, 2, 3], "x");
    const rewrapped = await rewrapVaultKey(old.kek, next.kek, protectedKey);
    expect(await decryptJson(await unwrapVaultKey(next.kek, rewrapped), ct, "x")).toEqual([1, 2, 3]);
    await expect(unwrapVaultKey(old.kek, rewrapped)).rejects.toBeInstanceOf(WrongPasswordError);
  });
});

describe("item encryption", () => {
  it("uses a fresh IV each time and detects tampering and context swaps", async () => {
    const { kek } = await deriveMasterKeys("pw", newSalt(), kdf);
    const { vaultKey } = await createVaultKey(kek);
    const a = await encryptJson(vaultKey, { secret: 1 }, "item:a");
    const b = await encryptJson(vaultKey, { secret: 1 }, "item:a");
    expect(a).not.toBe(b);

    // Moving a ciphertext to another item id (server-side swap) must fail.
    await expect(decryptJson(vaultKey, a, "item:b")).rejects.toBeInstanceOf(DecryptionError);

    const [v, iv, ct] = a.split(".");
    const bytes = fromBase64(ct!);
    bytes[0]! ^= 1;
    await expect(decryptJson(vaultKey, `${v}.${iv}.${toBase64(bytes)}`, "item:a")).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });
});
