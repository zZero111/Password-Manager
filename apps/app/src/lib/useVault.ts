import {
  type AccountOptions,
  DisconnectedError,
  NetworkError,
  type VaultItem,
  type VaultItemData,
  VaultSession,
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

export function useVault() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [session, setSession] = useState<VaultSession | null>(null);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [unreadable, setUnreadable] = useState(0);
  const [lockedEmail, setLockedEmail] = useState("");
  const [sync, setSync] = useState<SyncStatus>({ state: "idle", lastSyncAt: null, pending: 0 });
  const sessionRef = useRef<VaultSession | null>(null);
  sessionRef.current = session;

  // Initial state: is there a vault on this device?
  useEffect(() => {
    idbStorage
      .load()
      .then((v) => {
        if (v) {
          setLockedEmail(v.email);
          setPhase("locked");
        } else setPhase("signedOut");
      })
      .catch(() => setPhase("signedOut"));
  }, []);

  const refresh = useCallback(async (s = sessionRef.current) => {
    if (!s || s.locked) return;
    const res = await s.list();
    setItems(res.items);
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
        const state = e instanceof DisconnectedError ? "disconnected" : e instanceof NetworkError ? "offline" : "error";
        setSync((st) => ({ ...st, state, message: (e as Error).message, pending: s.pendingCount }));
      }
      await refresh(s);
    },
    [refresh],
  );

  const enter = useCallback(
    async (s: VaultSession) => {
      setSession(s);
      sessionRef.current = s;
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
    setPhase((p) => (p === "unlocked" ? "locked" : p));
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

  return {
    phase,
    items,
    unreadable,
    sync,
    lockedEmail,
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
      setPhase("signedOut");
    },
    async save(data: VaultItemData, id?: string) {
      const s = sessionRef.current!;
      const saved = await s.save(data, id);
      await refresh(s);
      void runSync(s);
      return saved;
    },
    async remove(id: string) {
      const s = sessionRef.current!;
      await s.remove(id);
      await refresh(s);
      void runSync(s);
    },
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
      await sessionRef.current!.changePassword(current, next);
    },
  };
}

export type Vault = ReturnType<typeof useVault>;
