import type { LocalVault, VaultStorage } from "@pm/core";

// The encrypted vault lives in IndexedDB inside the app's own webview storage.
// Nothing in it is readable without the master password.

const DB = "keyhold";
const STORE = "vault";
const KEY = "current";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const idbStorage: VaultStorage = {
  async load() {
    return ((await run("readonly", (s) => s.get(KEY))) as LocalVault | undefined) ?? null;
  },
  async save(vault) {
    await run("readwrite", (s) => s.put(vault, KEY));
  },
  async clear() {
    await run("readwrite", (s) => s.delete(KEY));
  },
};
