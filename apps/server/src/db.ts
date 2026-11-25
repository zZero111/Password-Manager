import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface UserRow {
  id: string;
  email: string;
  salt: string;
  kdf: string;
  auth_hash: string;
  protected_key: string;
  revision: number;
  created_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  name: string;
  created_at: string;
  last_seen_at: string;
}

export interface RevocationRow {
  token_hash: string;
  user_id: string;
  reason: string;
  created_at: string;
}

export interface ItemRow {
  id: string;
  data: string;
  deleted: number;
  revision: number;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  salt          TEXT NOT NULL,
  kdf           TEXT NOT NULL,
  auth_hash     TEXT NOT NULL,
  protected_key TEXT NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- Tokens the Server stopped accepting, and why, so a later request with one
-- gets the right reason (see RejectionReason in @pm/core/protocol).
CREATE TABLE IF NOT EXISTS revocations (
  token_hash TEXT PRIMARY KEY,
  -- No foreign key: revocations must outlive Account deletion so the Account's
  -- other Devices still learn they were signed out (and erase themselves).
  user_id    TEXT NOT NULL,
  reason     TEXT NOT NULL CHECK (reason IN ('disconnected', 'signed_out')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  revision   INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS items_by_revision ON items (user_id, revision);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/** Run `fn` inside a write transaction. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
