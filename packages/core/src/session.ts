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
import type { PushChange, ServerItem } from "./protocol";
import { type VaultItem, type VaultItemData, applyEdit, isTrashed, newId, trashExpired } from "./vault";

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
  private readonly api: ApiClient;

  private constructor(
    private state: LocalVault,
    vaultKey: CryptoKey,
    private storage: VaultStorage,
    fetchFn?: FetchFn,
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
    }
    await opts.storage.save(state);
    const session = new VaultSession(state, vaultKey, opts.storage, opts.fetch, opts.now);
    await session.sync();
    return session;
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
    await this.persist();
  }

  async changePassword(currentPassword: string, newPassword: string, kdf: KdfParams = DEFAULT_KDF): Promise<void> {
    const current = await deriveMasterKeys(currentPassword, this.state.salt, this.state.kdf);
    const salt = newSalt();
    const next = await deriveMasterKeys(newPassword, salt, kdf);
    const protectedKey = await rewrapVaultKey(current.kek, next.kek, this.state.protectedKey);
    await this.api.changePassword({ currentAuthKey: current.authKey, authKey: next.authKey, salt, kdf, protectedKey });
    Object.assign(this.state, { salt, kdf, protectedKey });
    await this.persist();
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

  devices() {
    return this.api.devices();
  }
  revokeDevice(id: string) {
    return this.api.revokeDevice(id);
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
    const p = await decryptJson<Payload>(this.key(), ct, itemAad(id));
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
      const pulled = await this.api.sync(this.state.revision);
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
      if (e instanceof DisconnectedError) {
        this.state.token = null;
        this.api.token = null;
      }
      await this.persist();
      throw e;
    }
  }

  private async pushPending(result: SyncResult): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sent = Object.values(this.state.pending);
      if (sent.length === 0) break;
      const res = await this.api.push(sent);
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
    try {
      const [l, r] = await Promise.all([this.decrypt(si.id, local.data), this.decrypt(si.id, si.data)]);
      remoteWins = changeTime(r) >= changeTime(l);
    } catch {
      // Can't read one side; keep whichever we can read (prefer local edit).
      remoteWins = false;
    }
    if (remoteWins) delete this.state.pending[si.id];
    else local.baseRevision = si.revision;
    return true;
  }

  private persist() {
    return this.storage.save(this.state);
  }
}
