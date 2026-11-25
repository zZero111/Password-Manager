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

/** Which secret field a Secret history entry came from. */
export type SecretField =
  | { kind: "password" }
  | { kind: "totp" }
  | { kind: "cardNumber" }
  | { kind: "cardCode" }
  | { kind: "hidden"; name: string };

/** A previous value of one of an Item's secret fields. */
export interface SecretHistoryEntry {
  field: SecretField;
  value: string;
  changedAt: string;
  /** True when the value lost a Conflict rather than being edited away. */
  fromConflict?: boolean;
}

/** v1 payload shape (Login password only); read via normalizeItem. */
interface LegacyPasswordHistoryEntry {
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
  /** Newest first, at most MAX_SECRET_HISTORY entries. */
  secretHistory: SecretHistoryEntry[];
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
    secretHistory: [],
    createdAt: ts,
    modifiedAt: ts,
  };
}

export const MAX_SECRET_HISTORY = 20;

/** Human label for a secret field, e.g. "Password" or "Hidden field “PIN”". */
export function secretFieldLabel(field: SecretField): string {
  switch (field.kind) {
    case "password":
      return "Password";
    case "totp":
      return "Authenticator key";
    case "cardNumber":
      return "Card number";
    case "cardCode":
      return "Security code";
    case "hidden":
      return `Hidden field “${field.name}”`;
  }
}

/**
 * An Item's current secret values, each with a stable key for comparing two
 * versions of the same Item (repeated hidden-field names are told apart by order).
 */
export function secretValues(item: VaultItemData): { key: string; field: SecretField; value: string }[] {
  const out: { key: string; field: SecretField; value: string }[] = [];
  if (item.login) {
    out.push({ key: "password", field: { kind: "password" }, value: item.login.password });
    out.push({ key: "totp", field: { kind: "totp" }, value: item.login.totp });
  }
  if (item.card) {
    out.push({ key: "cardNumber", field: { kind: "cardNumber" }, value: item.card.number });
    out.push({ key: "cardCode", field: { kind: "cardCode" }, value: item.card.code });
  }
  const seen = new Map<string, number>();
  for (const f of item.fields) {
    if (!f.hidden) continue;
    const n = seen.get(f.name) ?? 0;
    seen.set(f.name, n + 1);
    out.push({ key: `hidden:${n}:${f.name}`, field: { kind: "hidden", name: f.name }, value: f.value });
  }
  return out;
}

/** Previous secret values that `next` no longer holds, as Secret history entries. */
export function lostSecrets(previous: VaultItemData, next: VaultItemData, changedAt: string): SecretHistoryEntry[] {
  const now = new Map(secretValues(next).map((s) => [s.key, s.value]));
  return secretValues(previous)
    .filter((s) => s.value && now.get(s.key) !== s.value)
    .map((s) => ({ field: s.field, value: s.value, changedAt }));
}

/** Prepend entries to a Secret history, keeping the newest MAX_SECRET_HISTORY. */
export function pushSecretHistory(history: SecretHistoryEntry[], entries: SecretHistoryEntry[]): SecretHistoryEntry[] {
  return entries.length ? [...entries, ...history].slice(0, MAX_SECRET_HISTORY) : history;
}

/**
 * Settle a Conflict: the winner keeps the whole Item, and any of the loser's
 * secret values the winner no longer holds are added to the winner's Secret
 * history (marked fromConflict). Values already in that history are not
 * repeated. Returns undefined when nothing was lost. modifiedAt is kept as the
 * winner's, so recording history never makes the Item look like a newer edit.
 */
export function settleConflict(winner: VaultItemData, loser: VaultItemData, now = new Date()): VaultItemData | undefined {
  const known = new Set(winner.secretHistory.map((h) => `${JSON.stringify(h.field)}|${h.value}`));
  const lost = lostSecrets(loser, winner, now.toISOString())
    .filter((e) => !known.has(`${JSON.stringify(e.field)}|${e.value}`))
    .map((e) => ({ ...e, fromConflict: true }));
  if (lost.length === 0) return undefined;
  return { ...winner, secretHistory: pushSecretHistory(winner.secretHistory, lost) };
}

/**
 * Apply an edit: bump modifiedAt and record every changed secret value in
 * Secret history.
 */
export function applyEdit(previous: VaultItemData | undefined, next: VaultItemData, now = new Date()): VaultItemData {
  const ts = now.toISOString();
  const history = previous ? pushSecretHistory(next.secretHistory, lostSecrets(previous, next, ts)) : next.secretHistory;
  return { ...next, secretHistory: history, modifiedAt: ts, createdAt: previous?.createdAt ?? next.createdAt };
}

/**
 * Read an Item payload of any version as current VaultItemData: a v1
 * `passwordHistory` becomes Secret history entries for the password. Stored
 * data is not rewritten; the new shape is saved on the Item's next edit.
 */
export function normalizeItem<T extends VaultItemData>(raw: T): T {
  const { passwordHistory, ...rest } = raw as T & { passwordHistory?: LegacyPasswordHistoryEntry[] };
  if (Array.isArray(rest.secretHistory) && passwordHistory === undefined) return raw;
  const secretHistory = Array.isArray(rest.secretHistory)
    ? rest.secretHistory
    : (passwordHistory ?? []).map(
        (h): SecretHistoryEntry => ({ field: { kind: "password" }, value: h.password, changedAt: h.changedAt }),
      );
  return { ...rest, secretHistory } as T;
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
