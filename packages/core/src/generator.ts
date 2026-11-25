import { wordlist } from "@scure/bip39/wordlists/english.js";

/** Uniform random integer in [0, max) using rejection sampling (no modulo bias). */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0 || max > 2 ** 32) throw new Error("randomInt: bad range");
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % max;
  }
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

export interface PasswordOptions {
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
  /** Drop look-alike characters such as l, 1, I, O, 0. */
  avoidAmbiguous: boolean;
}

export const DEFAULT_PASSWORD_OPTIONS: PasswordOptions = {
  length: 20,
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: false,
};

const SETS = {
  lowercase: "abcdefghijklmnopqrstuvwxyz",
  uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digits: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.?/~",
};
const AMBIGUOUS = new Set("lI1O0o|`'\"");

function charsets(opts: PasswordOptions): string[] {
  return (Object.keys(SETS) as (keyof typeof SETS)[])
    .filter((k) => opts[k])
    .map((k) => [...SETS[k]].filter((c) => !(opts.avoidAmbiguous && AMBIGUOUS.has(c))).join(""));
}

/** Random password containing at least one character from every enabled set. */
export function generatePassword(opts: PasswordOptions = DEFAULT_PASSWORD_OPTIONS): string {
  const sets = charsets(opts);
  if (sets.length === 0) throw new Error("Enable at least one character set");
  if (opts.length < sets.length || opts.length > 256) throw new Error("Invalid password length");
  const all = sets.join("");
  const chars = sets.map((s) => s[randomInt(s.length)]!);
  while (chars.length < opts.length) chars.push(all[randomInt(all.length)]!);
  return shuffle(chars).join("");
}

export interface PassphraseOptions {
  words: number;
  separator: string;
  capitalize: boolean;
  includeNumber: boolean;
}

export const DEFAULT_PASSPHRASE_OPTIONS: PassphraseOptions = {
  words: 6,
  separator: "-",
  capitalize: true,
  includeNumber: true,
};

export function generatePassphrase(opts: PassphraseOptions = DEFAULT_PASSPHRASE_OPTIONS): string {
  if (opts.words < 3 || opts.words > 20) throw new Error("Passphrase must have 3–20 words");
  const words = Array.from({ length: opts.words }, () => {
    const w = wordlist[randomInt(wordlist.length)]!;
    return opts.capitalize ? w[0]!.toUpperCase() + w.slice(1) : w;
  });
  if (opts.includeNumber) {
    const i = randomInt(words.length);
    words[i] = words[i] + String(randomInt(10));
  }
  return words.join(opts.separator);
}

/** Entropy in bits of a password produced by these options (not of an arbitrary string). */
export function passwordEntropy(opts: PasswordOptions): number {
  const pool = charsets(opts).join("").length;
  return pool ? Math.round(opts.length * Math.log2(pool)) : 0;
}

export function passphraseEntropy(opts: PassphraseOptions): number {
  return Math.round(opts.words * Math.log2(wordlist.length) + (opts.includeNumber ? Math.log2(10 * opts.words) : 0));
}

/** Rough strength estimate for a user-chosen password (used for the master password meter). */
export function estimateStrength(pw: string): { bits: number; label: "weak" | "fair" | "good" | "strong" } {
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  const unique = new Set(pw).size;
  // Penalise heavy repetition ("aaaaaaaa", "abcabcabc").
  const effectiveLen = Math.min(pw.length, unique * 2);
  const bits = Math.round(effectiveLen * Math.log2(Math.max(pool, 1)));
  const label = bits < 40 ? "weak" : bits < 60 ? "fair" : bits < 80 ? "good" : "strong";
  return { bits, label };
}
