import {
  type AccountOptions,
  DeviceErasedError,
  DisconnectedError,
  NetworkError,
  type OfflineEraseDays,
  type VaultItem,
  type VaultItemData,
  VaultSession,
  offlineEraseAt,
} from "@pm/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSettings, updateSettings } from "./settings";
import { idbStorage } from "./storage";

export type Phase = "loading" | "signedOut" | "locked" | "unlocked";

export interface SyncStatus {
  state: "idle" | "syncing" | "offline" | "disconnected" | "error";
  lastSyncAt: number | null;
  message?: string;
  pending: number;
}

const SYNC_INTERVAL_MS = 60_000;
/** How often a Locked Device asks the Server whether it is still accepted. */
const CHECK_INTERVAL_MS = 3 * 60_000;

/** Why this Device's vault was erased: Signed out from another Device, or Offline erase. */
export type ErasedReason = "signedOut" | "offlineErase" | "accountDeleted";

export function useVault() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [session, setSession] = useState<VaultSession | null>(null);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [trash, setTrash] = useState<VaultItem[]>([]);
  const [unreadable, setUnreadable] = useState(0);
  const [lockedEmail, setLockedEmail] = useState("");
  /** Set when this Device's vault was erased (Sign out elsewhere, or Offline erase). */
  const [erasedNotice, setErasedNotice] = useState<ErasedReason | null>(null);
  /** When Offline erase would erase this Device if it stays offline (from the stored vault; no key needed). */
  const [offlineEraseDeadline, setOfflineEraseDeadline] = useState<Date | null>(null);
  /** Bumped when a per-Device setting changes on the session, to re-render. */
  const [, setDeviceSettingsTick] = useState(0);
  const [sync, setSync] = useState<SyncStatus>({ state: "idle", lastSyncAt: null, pending: 0 });
  const sessionRef = useRef<VaultSession | null>(null);
  sessionRef.current = session;

  /** This Device's vault is gone (Signed out elsewhere, or Offline erase): drop everything in memory. */
  const onErased = useCallback((reason: ErasedReason = "signedOut") => {
    sessionRef.current?.lock();
    sessionRef.current = null;
    setSession(null);
    setItems([]);
    setTrash([]);
    setOfflineEraseDeadline(null);
    setErasedNotice(reason);
    setPhase("signedOut");
  }, []);

  /** Check device: needs no Master password, so it runs while Locked. */
  const checkDevice = useCallback(async () => {
    if (sessionRef.current) return; // unlocked: the session's own Server calls do this
    const outcome = await VaultSession.checkDevice(idbStorage).catch(() => "offline" as const);
    if (sessionRef.current) return;
    if (outcome === "signedOut") return onErased("signedOut");
    if (outcome === "offlineErased") return onErased("offlineErase");
    const v = await idbStorage.load().catch(() => null);
    setOfflineEraseDeadline(v ? offlineEraseAt(v) : null);
  }, [onErased]);

  // Initial state: is there a vault on this device? Then check device right away.
  useEffect(() => {
    idbStorage
      .load()
      .then((v) => {
        if (v) {
          setLockedEmail(v.email);
          setOfflineEraseDeadline(offlineEraseAt(v));
          setPhase("locked");
          void checkDevice();
        } else setPhase("signedOut");
      })
      .catch(() => setPhase("signedOut"));
  }, [checkDevice]);

  // Every few minutes while Locked (unlocked Devices sync every minute instead).
  useEffect(() => {
    if (phase !== "locked") return;
    const id = setInterval(() => void checkDevice(), CHECK_INTERVAL_MS);
    const online = () => void checkDevice();
    window.addEventListener("online", online);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", online);
    };
  }, [phase, checkDevice]);

  const refresh = useCallback(async (s = sessionRef.current) => {
    if (!s || s.locked) return;
    const res = await s.list();
    setItems(res.items);
    setTrash(res.trash);
    setUnreadable(res.unreadable);
    setSync((st) => ({ ...st, pending: s.pendingCount }));
  }, []);

  const runSync = useCallback(
    async (s = sessionRef.current) => {
      if (!s || s.locked) return;
      if (!s.signedIn) {
        setSync((st) => ({ ...st, state: "disconnected", pending: s.pendingCount }));
        return;
      }
      setSync((st) => ({ ...st, state: "syncing" }));
      try {
        await s.sync();
        setSync({ state: "idle", lastSyncAt: Date.now(), pending: s.pendingCount });
      } catch (e) {
        if (e instanceof DeviceErasedError) return onErased();
        const state = e instanceof DisconnectedError ? "disconnected" : e instanceof NetworkError ? "offline" : "error";
        setSync((st) => ({ ...st, state, message: (e as Error).message, pending: s.pendingCount }));
      }
      await refresh(s);
    },
    [refresh, onErased],
  );

  /** Run a Server call from an unlocked session; a Sign out from elsewhere erases and shows the notice. */
  const guard = useCallback(
    async <T,>(call: (s: VaultSession) => Promise<T>): Promise<T> => {
      try {
        return await call(sessionRef.current!);
      } catch (e) {
        if (e instanceof DeviceErasedError) onErased();
        throw e;
      }
    },
    [onErased],
  );

  const enter = useCallback(
    async (s: VaultSession) => {
      setSession(s);
      sessionRef.current = s;
      setErasedNotice(null);
      setLockedEmail(s.email);
      setPhase("unlocked");
      await refresh(s);
      void runSync(s);
    },
    [refresh, runSync],
  );

  // Periodic + on-reconnect sync while unlocked.
  useEffect(() => {
    if (phase !== "unlocked") return;
    const id = setInterval(() => void runSync(), SYNC_INTERVAL_MS);
    const online = () => void runSync();
    window.addEventListener("online", online);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", online);
    };
  }, [phase, runSync]);

  const lock = useCallback(() => {
    sessionRef.current?.lock();
    setSession(null);
    setItems([]);
    setTrash([]);
    setPhase((p) => (p === "unlocked" ? "locked" : p));
    void idbStorage
      .load()
      .then((v) => setOfflineEraseDeadline(v ? offlineEraseAt(v) : null))
      .catch(() => {});
  }, []);

  // Auto-lock after inactivity, and optionally when the app is hidden.
  useEffect(() => {
    if (phase !== "unlocked") return;
    let last = Date.now();
    const touch = () => (last = Date.now());
    const events = ["pointerdown", "keydown", "wheel", "touchstart"];
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const check = setInterval(() => {
      const mins = getSettings().autoLockMinutes;
      if (mins > 0 && Date.now() - last > mins * 60_000) lock();
    }, 5_000);
    const vis = () => {
      if (document.visibilityState === "hidden" && getSettings().lockOnHide) lock();
    };
    document.addEventListener("visibilitychange", vis);
    return () => {
      events.forEach((e) => window.removeEventListener(e, touch));
      clearInterval(check);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [phase, lock]);

  const remember = (serverUrl: string, email: string) => updateSettings({ lastServerUrl: serverUrl, lastEmail: email });

  type Creds = Omit<AccountOptions, "storage">;

  async function change(op: (s: VaultSession) => Promise<unknown>) {
    const s = sessionRef.current!;
    await op(s);
    await refresh(s);
    void runSync(s);
  }

  return {
    phase,
    items,
    trash,
    unreadable,
    sync,
    lockedEmail,
    erasedNotice,
    dismissErasedNotice: () => setErasedNotice(null),
    offlineEraseDeadline,
    /** Offline erase for this Device only (null = Off). Not synced. */
    async setOfflineErase(days: OfflineEraseDays | null) {
      await sessionRef.current!.setOfflineErase(days);
      setDeviceSettingsTick((n) => n + 1);
    },
    serverUrl: session?.serverUrl ?? "",
    session,

    async register(o: Creds) {
      remember(o.serverUrl, o.email);
      await enter(await VaultSession.register({ ...o, storage: idbStorage }));
    },
    async login(o: Creds) {
      remember(o.serverUrl, o.email);
      await enter(await VaultSession.login({ ...o, storage: idbStorage }));
    },
    async unlock(password: string) {
      await enter(await VaultSession.unlock(idbStorage, password));
    },
    lock,
    async logout() {
      const s = sessionRef.current;
      if (s) await s.logout();
      else await idbStorage.clear();
      setSession(null);
      setItems([]);
      setTrash([]);
      setPhase("signedOut");
    },
    async save(data: VaultItemData, id?: string) {
      const s = sessionRef.current!;
      const saved = await s.save(data, id);
      await refresh(s);
      void runSync(s);
      return saved;
    },
    /** Delete (move to the Trash), Restore, Purge ("Delete permanently") and Empty Trash all sync right away. */
    delete: (id: string) => change((s) => s.delete(id)),
    restore: (id: string) => change((s) => s.restore(id)),
    purge: (id: string) => change((s) => s.purge(id)),
    emptyTrash: () => change((s) => s.emptyTrash()),
    /** Rename folder: rewrites every matching Item (Trash included) and syncs right away. */
    renameFolder: (from: string, to: string) => change((s) => s.renameFolder(from, to)),
    async importItems(data: VaultItemData[]) {
      const s = sessionRef.current!;
      const n = await s.addMany(data);
      await refresh(s);
      await runSync(s);
      return n;
    },
    syncNow: () => runSync(),
    async reauthenticate(password: string) {
      const s = sessionRef.current!;
      await s.reauthenticate(password);
      await runSync(s);
    },
    async changePassword(current: string, next: string) {
      await guard((s) => s.changePassword(current, next));
    },
    /** Account deletion: the Server removes the Account; this Device erases and shows the notice. */
    async deleteAccount(masterPassword: string) {
      await guard((s) => s.deleteAccount(masterPassword));
      onErased("accountDeleted");
    },
    /** Move this Account to another Server; this Device then syncs with the new Server. */
    async moveTo(o: { serverUrl: string; masterPassword: string; deleteOld: boolean }) {
      const res = await guard((s) => s.moveTo(o));
      const s = sessionRef.current!;
      remember(s.serverUrl, s.email);
      setDeviceSettingsTick((n) => n + 1); // serverUrl changed on the same session
      await runSync(s);
      return { ...res, serverUrl: s.serverUrl };
    },
    devices: () => guard((s) => s.devices()),
    revokeDevice: (id: string) => guard((s) => s.revokeDevice(id)),
  };
}

export type Vault = ReturnType<typeof useVault>;
