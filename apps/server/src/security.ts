import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * Hash the client's auth key for storage. The auth key is already a 256-bit
 * Argon2id-derived value, so this is defence in depth: a stolen database
 * can't be replayed to log in.
 */
export async function hashAuthKey(authKey: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(authKey, salt, 32, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyAuthKey(authKey: string, stored: string): Promise<boolean> {
  const [alg, saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scryptAsync(authKey, Buffer.from(saltB64, "base64"), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

// A fixed, valid-looking hash so unknown emails take as long as wrong passwords.
let dummyHash: Promise<string> | undefined;
export async function burnTime(authKey: string): Promise<void> {
  dummyHash ??= hashAuthKey("dummy");
  await verifyAuthKey(authKey, await dummyHash);
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Deterministic fake salt for unknown emails, so prelogin doesn't reveal which accounts exist. */
export function fakeSalt(secret: string, email: string): string {
  return createHmac("sha256", secret).update(`prelogin:${email}`).digest().subarray(0, 16).toString("base64");
}

/** Sliding-window failure counter used to slow down password guessing. */
export class FailureLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  fail(key: string, now = Date.now()): void {
    const list = this.recent(key, now);
    list.push(now);
    this.failures.set(key, list);
    if (this.failures.size > 10_000) this.prune(now);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string, now: number): number[] {
    return (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }

  private prune(now: number) {
    for (const [k, v] of this.failures) {
      if (v.every((t) => now - t >= this.windowMs)) this.failures.delete(k);
    }
  }
}
