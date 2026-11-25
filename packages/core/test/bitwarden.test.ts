import { describe, expect, it } from "vitest";
import {
  MAX_SECRET_HISTORY,
  type VaultItemData,
  applyEdit,
  importBitwardenJson,
  newItemData,
  normalizeItem,
  secretFieldLabel,
} from "../src";

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
    expect(gh!.secretHistory).toEqual([
      { field: { kind: "password" }, value: "old", changedAt: "2024-01-01T00:00:00.000Z" },
    ]);
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
  const at = new Date("2030-01-01");
  const ts = "2030-01-01T00:00:00.000Z";

  function edit(type: "login" | "card", setup: (d: VaultItemData) => void, change: (d: VaultItemData) => void) {
    const before = newItemData(type);
    setup(before);
    const after = structuredClone(before);
    change(after);
    return applyEdit(before, after, at);
  }

  it("records the previous password, labelled, and bumps modifiedAt", () => {
    const edited = edit("login", (d) => (d.login!.password = "one"), (d) => (d.login!.password = "two"));
    expect(edited.secretHistory).toEqual([{ field: { kind: "password" }, value: "one", changedAt: ts }]);
    expect(secretFieldLabel(edited.secretHistory[0]!.field)).toBe("Password");
    expect(edited.modifiedAt).toBe(ts);
  });

  it("records the previous Authenticator key", () => {
    const edited = edit("login", (d) => (d.login!.totp = "JBSWY3DP"), (d) => (d.login!.totp = "KRSXG5A"));
    expect(edited.secretHistory).toEqual([{ field: { kind: "totp" }, value: "JBSWY3DP", changedAt: ts }]);
    expect(secretFieldLabel(edited.secretHistory[0]!.field)).toBe("Authenticator key");
  });

  it("records the previous card number", () => {
    const edited = edit("card", (d) => (d.card!.number = "4111"), (d) => (d.card!.number = "5500"));
    expect(edited.secretHistory).toEqual([{ field: { kind: "cardNumber" }, value: "4111", changedAt: ts }]);
    expect(secretFieldLabel(edited.secretHistory[0]!.field)).toBe("Card number");
  });

  it("records the previous card code", () => {
    const edited = edit("card", (d) => (d.card!.code = "123"), (d) => (d.card!.code = "456"));
    expect(edited.secretHistory).toEqual([{ field: { kind: "cardCode" }, value: "123", changedAt: ts }]);
    expect(secretFieldLabel(edited.secretHistory[0]!.field)).toBe("Security code");
  });

  it("records the previous value of a hidden field, with its name", () => {
    const edited = edit(
      "login",
      (d) => (d.fields = [{ name: "PIN", value: "1111", hidden: true }]),
      (d) => (d.fields[0]!.value = "2222"),
    );
    expect(edited.secretHistory).toEqual([{ field: { kind: "hidden", name: "PIN" }, value: "1111", changedAt: ts }]);
    expect(secretFieldLabel(edited.secretHistory[0]!.field)).toBe("Hidden field “PIN”");
  });

  it("records nothing for non-secret edits", () => {
    const edited = edit(
      "login",
      (d) => {
        d.login!.password = "pw";
        d.fields = [{ name: "Team", value: "red", hidden: false }];
      },
      (d) => {
        d.name = "x";
        d.notes = "n";
        d.login!.username = "u";
        d.login!.uris = ["a.com"];
        d.fields[0]!.value = "blue";
      },
    );
    expect(edited.secretHistory).toEqual([]);
    const card = edit("card", (d) => (d.card!.number = "4111"), (d) => (d.card!.cardholderName = "A"));
    expect(card.secretHistory).toEqual([]);
  });

  it("keeps at most 20 entries, newest first", () => {
    let item = newItemData("login");
    item.login!.password = "p0";
    for (let i = 1; i <= 25; i++) {
      item = applyEdit(item, { ...item, login: { ...item.login!, password: `p${i}` } }, new Date(2030, 0, i));
    }
    expect(MAX_SECRET_HISTORY).toBe(20);
    expect(item.secretHistory).toHaveLength(20);
    expect(item.secretHistory.map((h) => h.value)).toEqual(Array.from({ length: 20 }, (_, i) => `p${24 - i}`));
  });
});

describe("normalizeItem", () => {
  it("lists a v1 Item's Password history as Secret history for the password", () => {
    const { secretHistory: _drop, ...rest } = newItemData("login");
    const v1 = { ...rest, passwordHistory: [{ password: "old", changedAt: "2024-01-01T00:00:00.000Z" }] };
    const item = normalizeItem(v1 as unknown as VaultItemData);
    expect(item.secretHistory).toEqual([
      { field: { kind: "password" }, value: "old", changedAt: "2024-01-01T00:00:00.000Z" },
    ]);
    expect("passwordHistory" in item).toBe(false);
  });
});
