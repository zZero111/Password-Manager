// Plaintext vault item model. Items only exist in this form in memory while
// the vault is unlocked; everywhere else (disk, network, server) they are
// encrypted as a whole with the vault key.

export type ItemType = "login" | "note" | "card";

export interface CustomField {
  name: string;
  value: string;
  hidden: boolean;
}

export interface LoginData {
  username: string;
  password: string;
  /** otpauth:// URI or bare base32 secret. */
  totp: string;
  uris: string[];
}

export interface CardData {
  cardholderName: string;
  brand: string;
  number: string;
  expMonth: string;
  expYear: string;
  code: string;
}

export interface PasswordHistoryEntry {
  password: string;
  changedAt: string;
}

export interface VaultItemData {
  type: ItemType;
  name: string;
  notes: string;
  favorite: boolean;
  folder: string;
  fields: CustomField[];
  login?: LoginData;
  card?: CardData;
  passwordHistory: PasswordHistoryEntry[];
  createdAt: string;
  modifiedAt: string;
  /** Set while the Item is in the Trash (encrypted with the rest; the Server never sees it). */
  trashedAt?: string;
}

export interface VaultItem extends VaultItemData {
  id: string;
}

export const emptyLogin = (): LoginData => ({ username: "", password: "", totp: "", uris: [] });
export const emptyCard = (): CardData => ({
  cardholderName: "",
  brand: "",
  number: "",
  expMonth: "",
  expYear: "",
  code: "",
});

export function newItemData(type: ItemType, now = new Date()): VaultItemData {
  const ts = now.toISOString();
  return {
    type,
    name: "",
    notes: "",
    favorite: false,
    folder: "",
    fields: [],
    login: type === "login" ? emptyLogin() : undefined,
    card: type === "card" ? emptyCard() : undefined,
    passwordHistory: [],
    createdAt: ts,
    modifiedAt: ts,
  };
}

const MAX_HISTORY = 10;

/**
 * Apply an edit: bump modifiedAt and record the previous password in history
 * when it changes.
 */
export function applyEdit(previous: VaultItemData | undefined, next: VaultItemData, now = new Date()): VaultItemData {
  const ts = now.toISOString();
  let history = next.passwordHistory;
  const oldPw = previous?.login?.password;
  if (oldPw && next.login && oldPw !== next.login.password) {
    history = [{ password: oldPw, changedAt: ts }, ...history].slice(0, MAX_HISTORY);
  }
  return { ...next, passwordHistory: history, modifiedAt: ts, createdAt: previous?.createdAt ?? next.createdAt };
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Case-insensitive search across name, username, URIs, folder and notes. */
export function matchesSearch(item: VaultItemData, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    item.name,
    item.folder,
    item.notes,
    item.login?.username,
    ...(item.login?.uris ?? []),
    item.card?.cardholderName,
    item.card?.brand,
  ];
  return haystack.some((h) => h?.toLowerCase().includes(q));
}

export function sortItems<T extends VaultItemData>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

export function folders(items: VaultItemData[]): string[] {
  return [...new Set(items.map((i) => i.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** Days an Item stays in the Trash before any unlocked Device Purges it. */
export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const isTrashed = (item: VaultItemData): boolean => Boolean(item.trashedAt);

/** Whole days left before a Trash Item is Purged (0 once due). */
export function trashDaysLeft(item: VaultItemData, now = new Date()): number {
  if (!item.trashedAt) return TRASH_DAYS;
  const left = TRASH_DAYS - (now.getTime() - Date.parse(item.trashedAt)) / DAY_MS;
  return Math.max(0, Math.ceil(left));
}

/** True once an Item has been in the Trash for more than TRASH_DAYS. */
export function trashExpired(item: VaultItemData, now = new Date()): boolean {
  return Boolean(item.trashedAt) && now.getTime() - Date.parse(item.trashedAt!) > TRASH_DAYS * DAY_MS;
}
