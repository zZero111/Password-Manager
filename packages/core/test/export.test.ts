import { describe, expect, it } from "vitest";
import { buildExport, parseImport, parseKeyholdExport } from "../src/export";
import { type VaultItem, newItemData } from "../src/vault";

const now = new Date("2031-03-01T09:00:00.000Z");

function item(name: string, extra: Partial<VaultItem> = {}): VaultItem {
  const data = newItemData("login", now);
  data.name = name;
  data.login!.password = "new";
  return { ...data, id: `id-${name}`, ...extra };
}

describe("Export", () => {
  it("contains no Trash Items, ids or Trash state", () => {
    const file = buildExport([item("Live"), item("Gone", { trashedAt: now.toISOString() })], now);
    expect(file).toMatchObject({ format: "keyhold", version: 2, exportedAt: now.toISOString() });
    expect(file.items.map((i) => i.name)).toEqual(["Live"]);
    expect(file.items[0]).not.toHaveProperty("id");
    expect(file.items[0]).not.toHaveProperty("trashedAt");
  });

  it("includes Secret history", () => {
    const secretHistory = [
      { field: { kind: "cardCode" as const }, value: "123", changedAt: now.toISOString() },
      { field: { kind: "password" as const }, value: "old", changedAt: now.toISOString() },
    ];
    const file = buildExport([item("Live", { secretHistory })], now);
    expect(file.items[0]?.secretHistory).toEqual(secretHistory);
    expect(parseImport(JSON.stringify(file)).items).toEqual(file.items);
  });

  it("imports a v1 Keyhold export with Password history converted to Secret history", () => {
    const { secretHistory: _s, ...v1Item } = newItemData("login", now);
    const v1 = {
      format: "keyhold",
      version: 1,
      exportedAt: now.toISOString(),
      items: [{ ...v1Item, name: "Old", passwordHistory: [{ password: "older", changedAt: now.toISOString() }] }],
    };
    const { items, warnings } = parseImport(JSON.stringify(v1));
    expect(warnings).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty("passwordHistory");
    expect(items[0]?.secretHistory).toEqual([{ field: { kind: "password" }, value: "older", changedAt: now.toISOString() }]);
  });

  it("rejects unknown Keyhold versions and leaves other files to the Bitwarden importer", () => {
    expect(() => parseKeyholdExport({ format: "keyhold", version: 3, items: [] })).toThrow(/version/);
    expect(parseKeyholdExport({ items: [] })).toBeNull();
    expect(() => parseImport("not json")).toThrow(/valid JSON/);
  });
});
