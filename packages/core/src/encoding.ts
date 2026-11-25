// Browser- and Node-safe encoding helpers (no Buffer dependency).

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Map([...B64].map((c, i) => [c, i]));

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const ch of clean) {
    const v = B64_LOOKUP.get(ch);
    if (v === undefined) throw new Error("Invalid base64");
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const utf8 = {
  encode: (s: string): Uint8Array => encoder.encode(s),
  decode: (b: Uint8Array): string => decoder.decode(b),
};

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Copy into a fresh ArrayBuffer-backed view (WebCrypto rejects some typed-array views). */
export function buf(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(b.length));
  copy.set(b);
  return copy;
}
