import { describe, expect, it } from "vitest";
import { applyEdit, importBitwardenJson, newItemData } from "../src";

const sample = {
  encrypted: false,
  folders: [{ id: "f1", name: "Work" }],
  items: [
    {
      type: 1,
      name: "GitHub",
      folderId: "f1",
      favorite: true,
      notes: "main account",
      fields: [
        { name: "PIN", value: "1234", type: 1 },
        { name: "linked", value: null, type: 3 },
      ],
      login: {
        username: "alice",
        password: "hunter2",
        totp: "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP",
        uris: [{ uri: "https://github.com", match: null }],
      },
      passwordHistory: [{ password: "old", lastUsedDate: "2024-01-01T00:00:00.000Z" }],
      revisionDate: "2025-01-01T00:00:00.000Z",
      creationDate: "2023-01-01T00:00:00.000Z",
    },
    { type: 2, name: "Wifi", notes: "pw: abc", secureNote: { type: 0 } },
    {
      type: 3,
      name: "Visa",
      card: { cardholderName: "Alice", brand: "Visa", number: "4111111111111111", expMonth: "1", expYear: "2030", code: "123" },
    },
    { type: 4, name: "Me", identity: { firstName: "Alice", ssn: "123-45-6789", city: null } },
    { type: 99, name: "Future thing" },
  ],
};

describe("Bitwarden import", () => {
  it("maps logins, notes, cards and identities", () => {
    const { items, warnings } = importBitwardenJson(JSON.stringify(sample));
    expect(items).toHaveLength(4);
    const [gh, note, card, id] = items;
    expect(gh).toMatchObject({
      type: "login",
      name: "GitHub",
      folder: "Work",
      favorite: true,
      fields: [{ name: "PIN", value: "1234", hidden: true }],
      login: { username: "alice", password: "hunter2", uris: ["https://github.com"] },
      createdAt: "2023-01-01T00:00:00.000Z",
      modifiedAt: "2025-01-01T00:00:00.000Z",
    });
    expect(gh!.passwordHistory).toEqual([{ password: "old", changedAt: "2024-01-01T00:00:00.000Z" }]);
    expect(note).toMatchObject({ type: "note", notes: "pw: abc" });
    expect(card!.card).toMatchObject({ number: "4111111111111111", code: "123" });
    expect(id).toMatchObject({ type: "note", folder: "Identities" });
    expect(id!.fields).toEqual([
      { name: "First name", value: "Alice", hidden: false },
      { name: "Social security number", value: "123-45-6789", hidden: true },
    ]);
    expect(warnings).toHaveLength(1);
  });

  it("rejects encrypted exports with a helpful message", () => {
    expect(() => importBitwardenJson(JSON.stringify({ encrypted: true, items: [] }))).toThrow(/unencrypted/);
    expect(() => importBitwardenJson("nope")).toThrow(/JSON/);
  });
});

describe("applyEdit", () => {
  it("records password history when the password changes", () => {
    const before = newItemData("login");
    before.login!.password = "one";
    const after = structuredClone(before);
    after.login!.password = "two";
    const edited = applyEdit(before, after, new Date("2030-01-01"));
    expect(edited.passwordHistory[0]).toEqual({ password: "one", changedAt: "2030-01-01T00:00:00.000Z" });
    expect(edited.modifiedAt).toBe("2030-01-01T00:00:00.000Z");
    expect(applyEdit(edited, { ...edited, name: "x" }).passwordHistory).toHaveLength(1);
  });
});
