import { importBitwardenJson } from "./bitwarden";
import { type VaultItemData, isTrashed, normalizeItem } from "./vault";

/** Keyhold Export file, version 2: the live Vault with Secret history. */
export interface KeyholdExport {
  format: "keyhold";
  version: 2;
  exportedAt: string;
  items: VaultItemData[];
}

/** Build an Export of the Items outside the Trash, without ids or Trash state. */
export function buildExport(items: VaultItemData[], now = new Date()): KeyholdExport {
  return {
    format: "keyhold",
    version: 2,
    exportedAt: now.toISOString(),
    items: items
      .filter((item) => !isTrashed(item))
      .map((item) => {
        const { id: _id, trashedAt: _trashedAt, ...rest } = normalizeItem(item) as VaultItemData & { id?: string };
        return rest;
      }),
  };
}

/** Read a Keyhold export (v1 or v2) as current VaultItemData; null if it is not one. */
export function parseKeyholdExport(json: unknown): VaultItemData[] | null {
  const file = json as { format?: unknown; version?: unknown; items?: unknown } | null;
  if (file?.format !== "keyhold") return null;
  if (file.version !== 1 && file.version !== 2) throw new Error(`Unsupported Keyhold export version: ${String(file.version)}`);
  if (!Array.isArray(file.items)) throw new Error("This Keyhold export has no items.");
  return (file.items as VaultItemData[]).map((item) => normalizeItem(item));
}

/** Parse an import file: a Keyhold export (v1 or v2) or a Bitwarden JSON export. */
export function parseImport(text: string): { items: VaultItemData[]; warnings: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("This file is not valid JSON.");
  }
  const keyhold = parseKeyholdExport(parsed);
  if (keyhold) return { items: keyhold, warnings: [] };
  return importBitwardenJson(text);
}
