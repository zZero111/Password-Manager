import { buf } from "./encoding";

// RFC 6238 TOTP (and RFC 4226 HOTP underneath), using WebCrypto HMAC.

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpParams {
  secret: Uint8Array;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  issuer?: string;
  account?: string;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error("Invalid base32 secret");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Parse an otpauth://totp/... URI or a bare base32 secret. */
export function parseTotp(input: string): TotpParams {
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith("otpauth://")) {
    return { secret: base32Decode(trimmed), algorithm: "SHA1", digits: 6, period: 30 };
  }
  const url = new URL(trimmed);
  if (url.host.toLowerCase() !== "totp") throw new Error("Only TOTP (time-based) codes are supported");
  const p = url.searchParams;
  const secret = p.get("secret");
  if (!secret) throw new Error("otpauth URI is missing a secret");
  const algorithm = (p.get("algorithm") ?? "SHA1").toUpperCase();
  if (algorithm !== "SHA1" && algorithm !== "SHA256" && algorithm !== "SHA512") {
    throw new Error(`Unsupported TOTP algorithm ${algorithm}`);
  }
  const digits = Number(p.get("digits") ?? 6);
  const period = Number(p.get("period") ?? 30);
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new Error("Invalid TOTP digits");
  if (!Number.isInteger(period) || period < 1 || period > 300) throw new Error("Invalid TOTP period");
  const label = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const [labelIssuer, account] = label.includes(":") ? label.split(/:(.*)/s) : [undefined, label];
  return {
    secret: base32Decode(secret),
    algorithm,
    digits,
    period,
    issuer: p.get("issuer") ?? labelIssuer?.trim() ?? undefined,
    account: account?.trim() || undefined,
  };
}

export async function hotp(secret: Uint8Array, counter: number, algorithm: TotpAlgorithm, digits: number): Promise<string> {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const hash = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" }[algorithm];
  const key = await crypto.subtle.importKey("raw", buf(secret), { name: "HMAC", hash }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

export interface TotpCode {
  code: string;
  /** Seconds until this code expires. */
  remaining: number;
  period: number;
}

export async function totpCode(params: TotpParams, nowMs = Date.now()): Promise<TotpCode> {
  const seconds = Math.floor(nowMs / 1000);
  const counter = Math.floor(seconds / params.period);
  const code = await hotp(params.secret, counter, params.algorithm, params.digits);
  return { code, remaining: params.period - (seconds % params.period), period: params.period };
}
