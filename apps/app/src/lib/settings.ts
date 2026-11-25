import { useSyncExternalStore } from "react";

// Non-secret preferences, kept in localStorage.

export interface Settings {
  autoLockMinutes: number; // 0 = never
  clipboardClearSeconds: number; // 0 = never
  lockOnHide: boolean;
  lastServerUrl: string;
  lastEmail: string;
}

const DEFAULTS: Settings = {
  autoLockMinutes: 15,
  clipboardClearSeconds: 30,
  lockOnHide: false,
  lastServerUrl: "",
  lastEmail: "",
};

const KEY = "keyhold.settings";
let current: Settings = load();
const listeners = new Set<() => void>();

function load(): Settings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // storage unavailable: keep in memory
  }
  listeners.forEach((l) => l());
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
