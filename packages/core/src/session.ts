import { ApiClient, type FetchFn, DisconnectedError, normalizeServerUrl } from "./api";
import {
  DEFAULT_KDF,
  DecryptionError,
  type KdfParams,
  createVaultKey,
  decryptJson,
  deriveMasterKeys,
  encryptJson,
  itemAad,
  newSalt,
  rewrapVaultKey,
  unwrapVaultKey,
} from "./crypto";
import { LIMITS, type PushChange, type ServerItem } from "./protocol";
import { type VaultItem, type VaultItemData, applyEdit, folderKey, folders, inFolder, isTrashed, newId, normalizeItem, resolveFolder, settleConflict, trashExpired } from "./vault";

/** Everything persisted on a device. Contains no plaintext secrets. */
export interface LocalVault {
  version: 1;
  serverUrl: string;
  email: string;
  userId: string;
  deviceName: string;
  /** Null once the server has rejected it; the vault still unlocks offline. */
  token: string | null;
  kdf: KdfParams;
  salt: string;
  protectedKey: string;
  /** Sync cursor: highest server revision pulled so far. */
  revision: number;
  /** Last known server copy of each item (encrypted). */
  items: Record<string, ServerItem>;
  /** Local edits not yet accepted by the server (encrypted). */
  pending: Record<string, PushChange>;
  /** ISO time this Device last reached the Server and was accepted. */
  lastReachedServer?: string;
  /**
   * Offline erase: erase this Device's vault after this many days without
   * reaching the Server. Absent = Off. Per Device; never synced.
   */
  offlineEraseDays?: OfflineEraseDays;
  /** ISO time Offline erase was turned on; the countdown never starts before it. */
  offlineEraseSince?: string;
}

/** The choices offered for Offline erase. */
export const OFFLINE_ERASE_DAYS = [7, 14, 30, 90] as const;
export type OfflineEraseDays = (typeof OFFLINE_ERASE_DAYS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When Offline erase will erase this Device if the Server stays unreachable,
 * or null when it is Off. Counts from the later of the last time the Server
 * was reached and the time the setting was turned on, so a vault without a
 * `lastReachedServer` (or one turned on long after) is never erased early.
 * Needs no key: works on the stored vault while Locked.
 */
export function offlineEraseAt(vault: LocalVault): Date | null {
  if (!vault.offlineEraseDays) return null;
  const starts = [vault.lastReachedServer, vault.offlineEraseSince]
    .filter((t): t is string => !!t)
    .map((t) => Date.parse(t))
    .filter((t) => !Number.isNaN(t));
  if (starts.length === 0) return null;
  return new Date(Math.max(...starts) + vault.offlineEraseDays * DAY_MS);
}

export interface VaultStorage {
  load(): Promise<LocalVault | null>;
  save(vault: LocalVault): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryStorage implements VaultStorage {
  private value: LocalVault | null = null;
  async load() {
    return this.value ? structuredClone(this.value) : null;
  }
  async save(v: LocalVault) {
    this.value = structuredClone(v);
  }
  async clear() {
    this.value = null;
  }
}

export class VaultLockedError extends Error {
  constructor() {
    super("Vault is locked");
    this.name = "VaultLockedError";
  }
}

/**
 * This Device was Signed out from another Device: its copy of the vault has
 * been erased and the session locked. Never thrown for a Disconnected Device.
 */
export class DeviceErasedError extends Error {
  constructor() {
    super("This Device was signed out and its vault erased");
    this.name = "DeviceErasedError";
  }
}

/** What `VaultSession.checkDevice` found out. */
export type DeviceCheck =
  /** The Server still accepts this Device; `lastReachedServer` was recorded. */
  | "accepted"
  /** Not accepted (e.g. Master password changed elsewhere); vault and pending changes kept, token cleared. */
  | "disconnected"
  /** Signed out from another Device: this Device's vault has been erased. */
  | "signedOut"
  /** Server unreachable (or erroring): nothing changed. */
  | "offline"
  /** Server unreachable and Offline erase's limit passed: this Device's vault has been erased. */
  | "offlineErased"
  /** No vault stored on this Device. */
  | "noVault";

interface Tombstone {
  tombstone: true;
  deletedAt: string;
}
type Payload = VaultItemData | Tombstone;
const changeTime = (p: Payload) => ("tombstone" in p ? p.deletedAt : p.modifiedAt);

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  /** Trash Items this Device Purged because they had been in the Trash too long. */
  purged: number;
}

/** Injectable clock, so the 30-day Trash can be tested. */
export type Clock = () => Date;

/** What a Move did. */
export interface MoveResult {
  /** Items uploaded to the new Server (live and Trash). */
  uploaded: number;
  /** True only if the old Account was deleted from the old Server. */
  oldAccountDeleted: boolean;
  /** Why deleting the old Account was skipped, when it was asked for. */
  oldAccountError?: string;
}
const realClock: Clock = () => new Date();

export interface AccountOptions {
  serverUrl: string;
  email: string;
  password: string;
  deviceName: string;
  storage: VaultStorage;
  fetch?: FetchFn;
  now?: Clock;
}

const stripId = ({ id: _id, ...rest }: VaultItem): VaultItemData => rest;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

export class VaultSession {
  private vaultKey: CryptoKey | null;
  private cache = new Map<string, Payload>();
  private inFlight: Promise<SyncResult> | null = null;
  private api: ApiClient;
  private erasedFlag = false;

  private constructor(
    private state: LocalVault,
    vaultKey: CryptoKey,
    private storage: VaultStorage,
    private readonly fetchFn?: FetchFn,
    private readonly now: Clock = realClock,
  ) {
    this.vaultKey = vaultKey;
    this.api = new ApiClient(state.serverUrl, state.token, fetchFn);
  }

  // ── Account lifecycle ──────────────────────────────────────────────

  /** Create a new account on the server and sign this device in. */
  static async register(opts: AccountOptions & { kdf?: KdfParams }): Promise<VaultSession> {
    const serverUrl = normalizeServerUrl(opts.serverUrl);
    const email = normalizeEmail(opts.email);
    const kdf = opts.kdf ?? DEFAULT_KDF;
    const salt = newSalt();
    const { kek, authKey } = await deriveMasterKeys(opts.password, salt, kdf);
    const { protectedKey } = await createVaultKey(kek);
    const api = new ApiClient(serverUrl, null, opts.fetch);
    await api.register({ email, authKey, salt, kdf, protectedKey });
    return VaultSession.login({ ...opts, serverUrl, email });
  }

  /** Sign in on a device (new or existing) and download the vault. */
  static async login(opts: AccountOptions): Promise<VaultSession> {
    const serverUrl = normalizeServerUrl(opts.serverUrl);
    const email = normalizeEmail(opts.email);
    const api = new ApiClient(serverUrl, null, opts.fetch);
    const { salt, kdf } = await api.prelogin(email);
    const { kek, authKey } = await deriveMasterKeys(opts.password, salt, kdf);
    const res = await api.login({ email, authKey, deviceName: opts.deviceName });
    const vaultKey = await unwrapVaultKey(kek, res.protectedKey);
    const state: LocalVault = {
      version: 1,
      serverUrl,
      email,
      userId: res.userId,
      deviceName: opts.deviceName,
      token: res.token,
      kdf: res.kdf,
      salt: res.salt,
      protectedKey: res.protectedKey,
      revision: 0,
      items: {},
      pending: {},
    };
    // Keep unsynced local edits if this device was already signed in to the same account.
    const previous = await opts.storage.load();
    if (previous && previous.userId === res.userId && previous.serverUrl === serverUrl) {
      state.items = previous.items;
      state.pending = previous.pending;
      state.revision = previous.revision;
      // Offline erase is a setting of this Device: keep it across sign-ins.
      if (previous.offlineEraseDays) {
        state.offlineEraseDays = previous.offlineEraseDays;
        state.offlineEraseSince = previous.offlineEraseSince;
      }
    }
    await opts.storage.save(state);
    const session = new VaultSession(state, vaultKey, opts.storage, opts.fetch, opts.now);
    await session.sync();
    return session;
  }

  /**
   * Ask the Server whether this Device is still accepted. Needs no Master
   * password, so it runs while Locked. A `signed_out` answer erases; so does
   * Offline erase, but only when the Server can't be reached and its limit
   * has passed — a reachable Server always just resets the countdown.
   */
  static async checkDevice(
    storage: VaultStorage,
    fetchFn?: FetchFn,
    opts: { now?: Clock } = {},
  ): Promise<DeviceCheck> {
    const now = opts.now ?? realClock;
    const state = await storage.load();
    if (!state) return "noVault";
    if (!state.token) return "disconnected";
    try {
      await new ApiClient(state.serverUrl, state.token, fetchFn).status();
    } catch (e) {
      if (e instanceof DisconnectedError) {
        if (e.reason === "signed_out") {
          await storage.clear();
          return "signedOut";
        }
        // Re-read so a write made meanwhile (e.g. an edit) is not lost.
        const latest = (await storage.load()) ?? state;
        if (latest.token === state.token) await storage.save({ ...latest, token: null });
        return "disconnected";
      }
      return (await VaultSession.offlineErase(storage, state, now)) ?? "offline";
    }
    const latest = (await storage.load()) ?? state;
    if (latest.token === state.token) {
      await storage.save({ ...latest, lastReachedServer: now().toISOString() });
    }
    return "accepted";
  }

  /** Erase storage if Offline erase's limit has passed; null if it hasn't. */
  private static async offlineErase(
    storage: VaultStorage,
    state: LocalVault,
    now: Clock,
  ): Promise<"offlineErased" | null> {
    const at = offlineEraseAt(state);
    if (!at || now().getTime() <= at.getTime()) return null;
    await storage.clear();
    return "offlineErased";
  }

  /** Unlock the vault stored on this device. Works offline. */
  static async unlock(
    storage: VaultStorage,
    password: string,
    fetchFn?: FetchFn,
    opts: { now?: Clock } = {},
  ): Promise<VaultSession> {
    const state = await storage.load();
    if (!state) throw new Error("No vault on this device");
    const { kek } = await deriveMasterKeys(password, state.salt, state.kdf);
    const vaultKey = await unwrapVaultKey(kek, state.protectedKey);
    return new VaultSession(state, vaultKey, storage, fetchFn, opts.now);
  }

  /**
   * Get a fresh token after the server ended this device's session (e.g. the
   * master password was changed elsewhere). Unsynced edits are kept.
   */
  async reauthenticate(password: string): Promise<void> {
    const { salt, kdf } = await this.api.prelogin(this.state.email);
    const { kek, authKey } = await deriveMasterKeys(password, salt, kdf);
    const res = await this.api.login({ email: this.state.email, authKey, deviceName: this.state.deviceName });
    this.vaultKey = await unwrapVaultKey(kek, res.protectedKey);
    Object.assign(this.state, { token: res.token, salt: res.salt, kdf: res.kdf, protectedKey: res.protectedKey });
    this.api.token = res.token;
    this.state.lastReachedServer = this.now().toISOString();
    await this.persist();
  }

  async changePassword(currentPassword: string, newPassword: string, kdf: KdfParams = DEFAULT_KDF): Promise<void> {
    const current = await deriveMasterKeys(currentPassword, this.state.salt, this.state.kdf);
    const salt = newSalt();
    const next = await deriveMasterKeys(newPassword, salt, kdf);
    const protectedKey = await rewrapVaultKey(current.kek, next.kek, this.state.protectedKey);
    await this.reach(() =>
      this.api.changePassword({ currentAuthKey: current.authKey, authKey: next.authKey, salt, kdf, protectedKey }),
    );
    Object.assign(this.state, { salt, kdf, protectedKey });
    await this.persist();
  }

  /**
   * Account deletion: proves the Master password to the Server, which removes
   * the Account, its Items and every Device; then this Device erases itself.
   * A wrong Master password rejects (Server 400) and changes nothing.
   */
  async deleteAccount(masterPassword: string): Promise<void> {
    const { authKey } = await deriveMasterKeys(masterPassword, this.state.salt, this.state.kdf);
    await this.reach(() => this.api.deleteAccount({ authKey }));
    await this.erase();
  }

  /**
   * Move: re-home this Account onto another Server from this Device's copy of
   * the Vault. Registers there with the same email, salt, KDF settings and
   * protected vault key (so the same Master password works), signs in, and
   * uploads every live and Trash Item plus pending changes as the existing
   * ciphertexts under their existing ids — never plaintext. Purge tombstones
   * are not carried over. Only once all of that succeeded does this Device
   * switch to the new Server; until then it is left exactly as it was.
   * Then, if asked, Account deletion on the old Server is attempted; if that
   * fails the Move still succeeds and the result says why it was skipped.
   */
  async moveTo(opts: {
    serverUrl: string;
    masterPassword: string;
    deviceName?: string;
    deleteOld: boolean;
  }): Promise<MoveResult> {
    const serverUrl = normalizeServerUrl(opts.serverUrl);
    if (serverUrl === this.state.serverUrl) throw new Error("This Device already uses that Server");
    const { email, salt, kdf, protectedKey } = this.state;
    const { kek, authKey } = await deriveMasterKeys(opts.masterPassword, salt, kdf);
    await unwrapVaultKey(kek, protectedKey); // throws WrongPasswordError

    // Snapshot what to upload: the Server copy of each Item, overridden by pending changes.
    const latest = new Map<string, { data: string; deleted: boolean }>();
    for (const si of Object.values(this.state.items)) latest.set(si.id, si);
    for (const pc of Object.values(this.state.pending)) latest.set(pc.id, pc);
    const changes: PushChange[] = [];
    for (const [id, { data, deleted }] of latest) {
      if (!deleted) changes.push({ id, data, deleted: false, baseRevision: 0 });
    }

    const deviceName = opts.deviceName ?? this.state.deviceName;
    const newApi = new ApiClient(serverUrl, null, this.fetchFn);
    await newApi.register({ email, authKey, salt, kdf, protectedKey });
    const res = await newApi.login({ email, authKey, deviceName });
    newApi.token = res.token;
    const items: Record<string, ServerItem> = {};
    for (let i = 0; i < changes.length; i += LIMITS.maxBatch) {
      const batch = changes.slice(i, i + LIMITS.maxBatch);
      const pushed = await newApi.push(batch);
      if (pushed.conflicts.length > 0) throw new Error("The new Server already had Items for this Account");
      const byId = new Map(batch.map((c) => [c.id, c]));
      for (const { id, revision } of pushed.applied) {
        const c = byId.get(id)!;
        items[id] = { id, data: c.data, deleted: false, revision };
      }
    }

    // Everything is on the new Server: switch this Device over.
    const oldApi = this.api;
    const keepPending: Record<string, PushChange> = {};
    // Edits made while uploading are kept as pending against the new Server.
    for (const [id, pc] of Object.entries(this.state.pending)) {
      if (latest.get(id) !== pc && !pc.deleted) keepPending[id] = { ...pc, baseRevision: items[id]?.revision ?? 0 };
    }
    Object.assign(this.state, {
      serverUrl,
      userId: res.userId,
      deviceName,
      token: res.token,
      revision: 0,
      items,
      pending: keepPending,
      lastReachedServer: this.now().toISOString(),
    });
    this.api = newApi;
    this.cache.clear();
    await this.persist();

    const result: MoveResult = { uploaded: Object.keys(items).length, oldAccountDeleted: false };
    if (opts.deleteOld) {
      try {
        await oldApi.deleteAccount({ authKey });
        result.oldAccountDeleted = true;
      } catch (e) {
        result.oldAccountError = e instanceof Error ? e.message : String(e);
      }
    }
    return result;
  }

  /** Sign out on the server and erase this device's copy of the vault. */
  async logout(): Promise<void> {
    try {
      if (this.state.token) await this.api.logout();
    } catch {
      // Offline or already expired: still wipe locally.
    }
    this.lock();
    await this.storage.clear();
  }

  lock(): void {
    this.vaultKey = null;
    this.cache.clear();
  }

  get locked() {
    return this.vaultKey === null;
  }
  get email() {
    return this.state.email;
  }
  get serverUrl() {
    return this.state.serverUrl;
  }
  get signedIn() {
    return this.state.token !== null;
  }
  get pendingCount() {
    return Object.keys(this.state.pending).length;
  }
  /** True once a `signed_out` answer erased this Device's vault. */
  get erased() {
    return this.erasedFlag;
  }
  get lastReachedServer() {
    return this.state.lastReachedServer;
  }
  /** Offline erase limit in days, or null when Off (the default). */
  get offlineEraseDays(): OfflineEraseDays | null {
    return this.state.offlineEraseDays ?? null;
  }

  /** Turn Offline erase on (7/14/30/90 days) or Off (null) for this Device only. */
  async setOfflineErase(days: OfflineEraseDays | null): Promise<void> {
    if (days !== null && !OFFLINE_ERASE_DAYS.includes(days)) throw new Error(`Unsupported Offline erase limit: ${days}`);
    if (days === null) {
      delete this.state.offlineEraseDays;
      delete this.state.offlineEraseSince;
    } else {
      this.state.offlineEraseDays = days;
      this.state.offlineEraseSince = this.now().toISOString();
    }
    await this.persist();
  }

  async devices() {
    const list = await this.reach(() => this.api.devices());
    await this.persist();
    return list;
  }
  async revokeDevice(id: string) {
    await this.reach(() => this.api.revokeDevice(id));
    await this.persist();
  }

  /**
   * Every authenticated Server call goes through here. Success records when
   * the Server was last reached; `signed_out` erases this Device and locks;
   * any other rejection leaves it Disconnected (vault kept).
   */
  private async reach<T>(call: () => Promise<T>): Promise<T> {
    if (this.erasedFlag) throw new DeviceErasedError();
    try {
      const res = await call();
      this.state.lastReachedServer = this.now().toISOString();
      return res;
    } catch (e) {
      if (e instanceof DisconnectedError) {
        this.state.token = null;
        this.api.token = null;
        if (e.reason === "signed_out") {
          await this.erase();
          throw new DeviceErasedError();
        }
      }
      throw e;
    }
  }

  private async erase(): Promise<void> {
    this.erasedFlag = true;
    this.lock();
    this.state.items = {};
    this.state.pending = {};
    await this.storage.clear();
  }

  // ── Items ──────────────────────────────────────────────────────────

  private key(): CryptoKey {
    if (!this.vaultKey) throw new VaultLockedError();
    return this.vaultKey;
  }

  private async decrypt(id: string, ct: string): Promise<Payload> {
    // Key by id too: a ciphertext is only valid for the item id it was
    // encrypted under (AAD), so the cache must not let it be reused elsewhere.
    const cacheKey = `${id}|${ct}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const raw = await decryptJson<Payload>(this.key(), ct, itemAad(id));
    const p = "tombstone" in raw ? raw : normalizeItem(raw);
    this.cache.set(cacheKey, p);
    return p;
  }

  private current(id: string): { data: string; deleted: boolean } | undefined {
    return this.state.pending[id] ?? this.state.items[id];
  }

  /**
   * All Items: `items` are live, `trash` are in the Trash. Items that fail to
   * decrypt are reported in `unreadable`.
   */
  async list(): Promise<{ items: VaultItem[]; trash: VaultItem[]; unreadable: number }> {
    const ids = new Set([...Object.keys(this.state.items), ...Object.keys(this.state.pending)]);
    const items: VaultItem[] = [];
    const trash: VaultItem[] = [];
    let unreadable = 0;
    for (const id of ids) {
      const rec = this.current(id);
      if (!rec || rec.deleted) continue;
      try {
        const p = await this.decrypt(id, rec.data);
        if (!("tombstone" in p)) (isTrashed(p) ? trash : items).push({ ...p, id });
      } catch (e) {
        if (e instanceof DecryptionError) unreadable++;
        else throw e;
      }
    }
    return { items, trash, unreadable };
  }

  async get(id: string): Promise<VaultItem | undefined> {
    const rec = this.current(id);
    if (!rec || rec.deleted) return undefined;
    const p = await this.decrypt(id, rec.data);
    return "tombstone" in p ? undefined : { ...p, id };
  }

  private baseRevision(id: string) {
    return this.state.pending[id]?.baseRevision ?? this.state.items[id]?.revision ?? 0;
  }

  async save(data: VaultItemData | VaultItem, id: string = newId()): Promise<VaultItem> {
    const previous = await this.get(id);
    // The id lives outside the encrypted payload (it's bound in as AAD instead).
    const { id: _ignored, ...plain } = data as VaultItem;
    const final = applyEdit(previous && stripId(previous), plain, this.now());
    const ct = await encryptJson(this.key(), final, itemAad(id));
    this.state.pending[id] = { id, data: ct, deleted: false, baseRevision: this.baseRevision(id) };
    await this.persist();
    return { ...final, id };
  }

  /** Delete: move an Item to the Trash. An ordinary edit that syncs to every Device. */
  async delete(id: string): Promise<void> {
    const item = await this.get(id);
    if (!item || isTrashed(item)) return;
    await this.save({ ...item, trashedAt: this.now().toISOString() }, id);
  }

  /** Take an Item out of the Trash, with its Folder and fields intact. */
  async restore(id: string): Promise<void> {
    const item = await this.get(id);
    if (!item || !isTrashed(item)) return;
    const { trashedAt: _t, ...rest } = item;
    await this.save(rest, id);
  }

  /**
   * Rename folder: rewrite the Folder on every matching Item, Trash included,
   * as ordinary edits. When `to` matches an existing Folder they merge.
   * Returns how many Items changed.
   */
  async renameFolder(from: string, to: string): Promise<number> {
    if (!folderKey(from) || !folderKey(to)) return 0;
    const { items, trash } = await this.list();
    // Onto another existing Folder: merge, keeping that Folder's spelling.
    const others = folders([...items, ...trash]).filter((f) => !inFolder(f, from));
    const name = resolveFolder(others, to);
    const now = this.now();
    const key = this.key();
    let changed = 0;
    for (const item of [...items, ...trash]) {
      if (!inFolder(item.folder, from) || item.folder === name) continue;
      const { id, ...previous } = item;
      const final = applyEdit(previous, { ...previous, folder: name }, now);
      const ct = await encryptJson(key, final, itemAad(id));
      this.state.pending[id] = { id, data: ct, deleted: false, baseRevision: this.baseRevision(id) };
      changed++;
    }
    if (changed) await this.persist();
    return changed;
  }

  /** Purge every Item in the Trash. Returns how many were Purged. */
  async emptyTrash(): Promise<number> {
    const { trash } = await this.list();
    for (const item of trash) await this.purge(item.id);
    return trash.length;
  }

  /** Purge: permanently remove an Item on every Device. */
  async purge(id: string): Promise<void> {
    if (!this.state.items[id]) {
      // Never reached the server: just drop it.
      delete this.state.pending[id];
    } else {
      const tomb: Tombstone = { tombstone: true, deletedAt: this.now().toISOString() };
      const ct = await encryptJson(this.key(), tomb, itemAad(id));
      this.state.pending[id] = { id, data: ct, deleted: true, baseRevision: this.baseRevision(id) };
    }
    await this.persist();
  }

  /** Add many items at once (e.g. an import), keeping their timestamps. */
  async addMany(items: VaultItemData[]): Promise<number> {
    const key = this.key();
    for (const item of items) {
      const id = newId();
      this.state.pending[id] = { id, data: await encryptJson(key, item, itemAad(id)), deleted: false, baseRevision: 0 };
    }
    await this.persist();
    return items.length;
  }

  // ── Sync ───────────────────────────────────────────────────────────

  /** Pull remote changes, then push local ones. Concurrent calls share one run. */
  sync(): Promise<SyncResult> {
    this.inFlight ??= this.doSync().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doSync(): Promise<SyncResult> {
    const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, purged: 0 };
    try {
      const pulled = await this.reach(() => this.api.sync(this.state.revision));
      for (const si of pulled.items) {
        if (await this.mergeRemote(si)) result.conflicts++;
        result.pulled++;
      }
      this.state.revision = Math.max(this.state.revision, pulled.revision);
      await this.pushPending(result);

      // After a successful sync, Purge anything 30+ days in the Trash, on every Device.
      const now = this.now();
      const { trash } = this.locked ? { trash: [] } : await this.list();
      for (const item of trash) {
        if (!trashExpired(item, now)) continue;
        await this.purge(item.id);
        result.purged++;
      }
      if (result.purged > 0) await this.pushPending(result);

      await this.persist();
      return result;
    } catch (e) {
      await this.persist();
      throw e;
    }
  }

  private async pushPending(result: SyncResult): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sent = Object.values(this.state.pending);
      if (sent.length === 0) break;
      const res = await this.reach(() => this.api.push(sent));
      const byId = new Map(sent.map((c) => [c.id, c]));
      for (const { id, revision } of res.applied) {
        const change = byId.get(id)!;
        this.state.items[id] = { id, data: change.data, deleted: change.deleted, revision };
        if (this.state.pending[id] === change) delete this.state.pending[id];
        else if (this.state.pending[id]) this.state.pending[id].baseRevision = revision; // edited mid-flight
        result.pushed++;
      }
      for (const si of res.conflicts) {
        await this.mergeRemote(si);
        result.conflicts++;
      }
      if (res.conflicts.length === 0) break;
    }
  }

  /**
   * Apply a server copy of an item. If there is an unsynced local edit of the
   * same item, the most recent change wins. Returns true if that happened.
   */
  private async mergeRemote(si: ServerItem): Promise<boolean> {
    const known = this.state.items[si.id];
    if (known && known.revision >= si.revision) return false;
    this.state.items[si.id] = si;

    const local = this.state.pending[si.id];
    if (!local || si.revision <= local.baseRevision) return false;
    if (local.data === si.data) {
      delete this.state.pending[si.id];
      return false;
    }
    let remoteWins: boolean;
    let merged: VaultItemData | undefined;
    try {
      const [l, r] = await Promise.all([this.decrypt(si.id, local.data), this.decrypt(si.id, si.data)]);
      remoteWins = changeTime(r) >= changeTime(l);
      // Neither side Purged: the loser's secrets survive in the winner's Secret history.
      if (!("tombstone" in l) && !("tombstone" in r)) {
        merged = remoteWins ? settleConflict(r, l, this.now()) : settleConflict(l, r, this.now());
      }
    } catch {
      // Can't read one side; keep whichever we can read (prefer local edit).
      remoteWins = false;
    }
    if (merged) {
      const winner = remoteWins ? si : local;
      const data = await encryptJson(this.key(), merged, itemAad(si.id));
      this.state.pending[si.id] = { id: si.id, data, deleted: winner.deleted, baseRevision: si.revision };
    } else if (remoteWins) delete this.state.pending[si.id];
    else local.baseRevision = si.revision;
    return true;
  }

  private async persist() {
    // Never write back a vault that a Sign out erased.
    if (!this.erasedFlag) await this.storage.save(this.state);
  }
}
