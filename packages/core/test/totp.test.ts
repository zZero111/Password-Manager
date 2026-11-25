import { describe, expect, it } from "vitest";
import { hotp, parseTotp, totpCode, utf8 } from "../src";

describe("TOTP", () => {
  // RFC 6238 Appendix B test vectors (8 digits).
  const seeds = {
    SHA1: utf8.encode("12345678901234567890"),
    SHA256: utf8.encode("12345678901234567890123456789012"),
    SHA512: utf8.encode("1234567890123456789012345678901234567890123456789012345678901234"),
  } as const;
  const vectors: [number, Record<keyof typeof seeds, string>][] = [
    [59, { SHA1: "94287082", SHA256: "46119246", SHA512: "90693936" }],
    [1111111109, { SHA1: "07081804", SHA256: "68084774", SHA512: "25091201" }],
    [1234567890, { SHA1: "89005924", SHA256: "91819424", SHA512: "93441116" }],
    [20000000000, { SHA1: "65353130", SHA256: "77737706", SHA512: "47863826" }],
  ];
  for (const [t, expected] of vectors) {
    for (const alg of ["SHA1", "SHA256", "SHA512"] as const) {
      it(`RFC 6238 ${alg} @ ${t}`, async () => {
        const { code } = await totpCode({ secret: seeds[alg], algorithm: alg, digits: 8, period: 30 }, t * 1000);
        expect(code).toBe(expected[alg]);
      });
    }
  }

  it("RFC 4226 HOTP vectors", async () => {
    const expected = ["755224", "287082", "359152", "969429", "338314"];
    for (let i = 0; i < expected.length; i++) {
      expect(await hotp(seeds.SHA1, i, "SHA1", 6)).toBe(expected[i]);
    }
  });

  it("parses otpauth URIs and bare secrets", async () => {
    const p = parseTotp("otpauth://totp/GitHub:alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=6&period=30");
    expect(p.issuer).toBe("GitHub");
    expect(p.account).toBe("alice@example.com");
    expect(p.digits).toBe(6);
    const bare = parseTotp("jbsw y3dp ehpk 3pxp");
    expect([...bare.secret]).toEqual([...p.secret]);
    expect(() => parseTotp("otpauth://hotp/x?secret=JBSWY3DP")).toThrow(/TOTP/);
    expect(() => parseTotp("not!base32")).toThrow();
  });

  it("reports seconds remaining", async () => {
    const r = await totpCode(parseTotp("JBSWY3DPEHPK3PXP"), 1_000_010_000);
    expect(r.remaining).toBe(30 - (1_000_010 % 30));
  });
});
