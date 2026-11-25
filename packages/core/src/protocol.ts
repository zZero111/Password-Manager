import type { KdfParams } from "./crypto";

// Wire types shared by the app and the sync server. Every `data` field is
// ciphertext produced by the client; the server treats it as an opaque string.

export const LIMITS = {
  maxItemBytes: 512 * 1024,
  maxBatch: 500,
  maxEmail: 254,
  maxDeviceName: 100,
} as const;

export const KDF_MIN = { memoryKiB: 19 * 1024, iterations: 2, parallelism: 1 } as const;
export const KDF_MAX = { memoryKiB: 1024 * 1024, iterations: 20, parallelism: 16 } as const;

export interface PreloginRequest {
  email: string;
}
export interface PreloginResponse {
  kdf: KdfParams;
  salt: string;
}

export interface RegisterRequest {
  email: string;
  authKey: string;
  salt: string;
  kdf: KdfParams;
  protectedKey: string;
}

export interface LoginRequest {
  email: string;
  authKey: string;
  deviceName: string;
}
export interface LoginResponse {
  token: string;
  userId: string;
  protectedKey: string;
  kdf: KdfParams;
  salt: string;
}

export interface ServerItem {
  id: string;
  /** Encrypted item, or encrypted tombstone when `deleted`. */
  data: string;
  deleted: boolean;
  revision: number;
}

export interface SyncResponse {
  /** Highest revision on the server for this account. Use as `since` next time. */
  revision: number;
  items: ServerItem[];
}

export interface PushChange {
  id: string;
  data: string;
  deleted: boolean;
  /** Revision of the server copy this change was based on; 0 for a new item. */
  baseRevision: number;
}
export interface PushRequest {
  changes: PushChange[];
}
export interface PushResponse {
  applied: { id: string; revision: number }[];
  /** Changes rejected because the server copy moved on; contains the server copy. */
  conflicts: ServerItem[];
}

export interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface ChangePasswordRequest {
  currentAuthKey: string;
  authKey: string;
  salt: string;
  kdf: KdfParams;
  protectedKey: string;
}

export interface ApiErrorBody {
  error: string;
}
