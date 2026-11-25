import { describe, expect, it } from "vitest";
import {
  DEFAULT_PASSWORD_OPTIONS,
  estimateStrength,
  generatePassphrase,
  generatePassword,
  passwordEntropy,
  randomInt,
} from "../src";

describe("generator", () => {
  it("randomInt is in range and roughly uniform", () => {
    const counts = new Array(6).fill(0);
    for (let i = 0; i < 6000; i++) counts[randomInt(6)]++;
    for (const c of counts) expect(c).toBeGreaterThan(800);
  });

  it("includes every enabled character class", () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword({ ...DEFAULT_PASSWORD_OPTIONS, length: 8 });
      expect(pw).toHaveLength(8);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[^a-zA-Z0-9]/);
    }
  });

  it("respects disabled sets and ambiguity filter", () => {
    const opts = { length: 64, lowercase: true, uppercase: false, digits: true, symbols: false, avoidAmbiguous: true };
    for (let i = 0; i < 50; i++) expect(generatePassword(opts)).toMatch(/^[a-km-np-z2-9]+$/);
    expect(() => generatePassword({ ...opts, lowercase: false, digits: false })).toThrow();
  });

  it("generates passphrases", () => {
    const p = generatePassphrase({ words: 5, separator: " ", capitalize: false, includeNumber: false });
    expect(p.split(" ")).toHaveLength(5);
    expect(p).toMatch(/^[a-z ]+$/);
  });

  it("estimates entropy", () => {
    expect(passwordEntropy(DEFAULT_PASSWORD_OPTIONS)).toBeGreaterThan(120);
    expect(estimateStrength("password").label).toBe("weak");
    expect(estimateStrength("aaaaaaaaaaaaaaaaaaaa").label).toBe("weak");
    expect(estimateStrength("Tr0ub4dor&3-horse-Battery").label).toBe("strong");
  });
});
