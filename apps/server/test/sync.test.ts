import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApiError,
  type KdfParams,
  MIN_KDF,
  MemoryStorage,
  SessionExpiredError,
  VaultSession,
  WrongPasswordError,
  newItemData,
} from "@pm/core";
import { buildServer } from "../src/app";

const kdf: KdfParams = { algorithm: "argon2id", ...MIN_KDF };
const PASSWORD = "correct horse battery staple";

let app: FastifyInstance;
let url: string;
let dbPath: string;

async function start(signups: "open" | "closed" = "open") {
  dbPath = join(mkdtempSync(join(tmpdir(), "pm-")), "vault.db");
  app = await buildServer({ dbPath, signups, maxLoginFailures: 5 });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  url = `http://127.0.0.1:${addr.port}`;
}

beforeEach(() => start());
afterEach(() => app.close());

const login = (storage = new MemoryStorage(), deviceName = "Device B", password = PASSWORD) =>
  VaultSession.login({ serverUrl: url, email: "alice@example.com", password, deviceName, storage });

async function registerAlice() {
  const storage = new MemoryStorage();
  const session = await VaultSession.register({
    serverUrl: url,
    email: " Alice@Example.com ",
    password: PASSWORD,
    deviceName: "Device A",
    storage,
    kdf,
  });
  return { session, storage };
}

function login_(name: string, password = "hunter2") {
  const item = newItemData("login");
  item.name = name;
  item.login!.username = "alice";
  item.login!.password = password;
  return item;
}

describe("accounts", () => {
  it("registers, logs in on a second device and rejects wrong passwords", async () => {
    await registerAlice();
    const b = await login();
    expect(b.email).toBe("alice@example.com");
    await expect(login(new MemoryStorage(), "x", "wrong password")).rejects.toThrow(/Incorrect/);
  });

  it("does not reveal whether an account exists via prelogin", async () => {
    const res1 = await fetch(`${url}/api/accounts/prelogin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com" }),
    }).then((r) => r.json());
    const res2 = await fetch(`${url}/api/accounts/prelogin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com" }),
    }).then((r) => r.json());
    expect(res1).toEqual(res2);
    expect(res1.salt).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("rejects duplicate registrations and closed sign-ups", async () => {
    await registerAlice();
    await expect(registerAlice()).rejects.toThrow(/already exists/);
    await app.close();
    await start("closed");
    await expect(registerAlice()).rejects.toThrow(/closed/);
  });

  it("rate-limits repeated wrong passwords", async () => {
    await registerAlice();
    for (let i = 0; i < 5; i++) await expect(login(new MemoryStorage(), "x", `nope${i}`)).rejects.toThrow(/Incorrect/);
    await expect(login()).rejects.toMatchObject({ status: 429 });
  });

  it("unlocks offline from local storage and detects a wrong password", async () => {
    const { session, storage } = await registerAlice();
    await session.save(login_("GitHub"));
    session.lock();
    await app.close(); // server gone
    const again = await VaultSession.unlock(storage, PASSWORD);
    expect((await again.list()).items.map((i) => i.name)).toEqual(["GitHub"]);
    await expect(VaultSession.unlock(storage, "nope")).rejects.toBeInstanceOf(WrongPasswordError);
    await start(); // so afterEach can close
  });
});

describe("sync", () => {
  it("propagates creates, edits and deletes between devices", async () => {
    const { session: a } = await registerAlice();
    const b = await login();

    const gh = await a.save(login_("GitHub"));
    await a.sync();
    await b.sync();
    expect((await b.get(gh.id))?.login?.password).toBe("hunter2");

    await b.save({ ...(await b.get(gh.id))!, login: { ...gh.login!, password: "s3cret" } }, gh.id);
    await b.sync();
    await a.sync();
    const edited = await a.get(gh.id);
    expect(edited?.login?.password).toBe("s3cret");
    expect(edited?.passwordHistory[0]?.password).toBe("hunter2");

    await a.remove(gh.id);
    await a.sync();
    await b.sync();
    expect(await b.get(gh.id)).toBeUndefined();
    expect((await b.list()).items).toHaveLength(0);
  });

  it("queues offline edits and resolves conflicts by most recent change", async () => {
    const { session: a } = await registerAlice();
    const b = await login();
    const item = await a.save(login_("Email"));
    await a.sync();
    await b.sync();

    // Both devices edit offline; B edits later so B should win.
    await a.save({ ...item, notes: "from A" }, item.id);
    await new Promise((r) => setTimeout(r, 5));
    await b.save({ ...item, notes: "from B" }, item.id);
    expect(a.pendingCount).toBe(1);

    await a.sync(); // A pushes first and is accepted
    const res = await b.sync(); // B sees A's change, B's is newer, B re-pushes
    expect(res.conflicts).toBeGreaterThan(0);
    await a.sync();
    expect((await a.get(item.id))?.notes).toBe("from B");
    expect((await b.get(item.id))?.notes).toBe("from B");
    expect(a.pendingCount + b.pendingCount).toBe(0);
  });

  it("an older offline edit loses to a newer one already on the server", async () => {
    const { session: a } = await registerAlice();
    const b = await login();
    const item = await a.save(login_("Bank"));
    await a.sync();
    await b.sync();

    await b.save({ ...item, notes: "old edit from B" }, item.id);
    await new Promise((r) => setTimeout(r, 5));
    await a.save({ ...item, notes: "newer edit from A" }, item.id);
    await a.sync();
    await b.sync();
    expect((await b.get(item.id))?.notes).toBe("newer edit from A");
    expect(b.pendingCount).toBe(0);
  });

  it("imports many items in one go", async () => {
    const { session: a } = await registerAlice();
    await a.addMany(Array.from({ length: 120 }, (_, i) => login_(`Site ${i}`)));
    const r = await a.sync();
    expect(r.pushed).toBe(120);
    const b = await login();
    expect((await b.list()).items).toHaveLength(120);
  });
});

describe("zero-knowledge storage", () => {
  it("the server database never contains plaintext", async () => {
    const { session: a } = await registerAlice();
    await a.save(login_("Super Secret Bank", "PLAINTEXT-PASSWORD-123"));
    await a.sync();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const dump = JSON.stringify([
      db.prepare("SELECT * FROM items").all(),
      db.prepare("SELECT * FROM users").all(),
      db.prepare("SELECT * FROM sessions").all(),
    ]);
    db.close();
    expect(dump).not.toContain("PLAINTEXT-PASSWORD-123");
    expect(dump).not.toContain("Super Secret Bank");
    expect(dump).not.toContain(PASSWORD);
  });

  it("detects a server that swaps ciphertexts between items", async () => {
    const { session: a } = await registerAlice();
    await a.save(login_("One"));
    await a.save(login_("Two"));
    await a.sync();
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT id, data FROM items").all() as { id: string; data: string }[];
    db.prepare("UPDATE items SET data = ?, revision = revision + 10 WHERE id = ?").run(rows[1]!.data, rows[0]!.id);
    db.prepare("UPDATE users SET revision = revision + 10").run();
    db.close();
    const b = await login();
    const { items, unreadable } = await b.list();
    expect(unreadable).toBe(1);
    expect(items).toHaveLength(1);
  });
});

describe("master password change", () => {
  it("signs out other devices, which re-authenticate with the new password and keep offline edits", async () => {
    const { session: a } = await registerAlice();
    const bStorage = new MemoryStorage();
    const b = await login(bStorage);
    const item = await a.save(login_("Shop"));
    await a.sync();
    await b.sync();

    await a.changePassword(PASSWORD, "a brand new master password");
    await b.save({ ...item, notes: "edited on B while signed out" }, item.id);
    await expect(b.sync()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(b.signedIn).toBe(false);

    await expect(b.reauthenticate(PASSWORD)).rejects.toBeInstanceOf(ApiError);
    await b.reauthenticate("a brand new master password");
    await b.sync();
    await a.sync();
    expect((await a.get(item.id))?.notes).toBe("edited on B while signed out");

    // The new password now unlocks B's local copy; the old one doesn't.
    await expect(VaultSession.unlock(bStorage, PASSWORD)).rejects.toBeInstanceOf(WrongPasswordError);
    expect((await (await VaultSession.unlock(bStorage, "a brand new master password")).list()).items).toHaveLength(1);
  });

  it("rejects a wrong current password", async () => {
    const { session: a } = await registerAlice();
    await expect(a.changePassword("wrong", "whatever new")).rejects.toBeInstanceOf(WrongPasswordError);
  });
});

describe("devices", () => {
  it("lists and revokes sessions", async () => {
    const { session: a } = await registerAlice();
    const b = await login();
    const devices = await a.devices();
    expect(devices.map((d) => d.name).sort()).toEqual(["Device A", "Device B"]);
    expect(devices.find((d) => d.current)?.name).toBe("Device A");
    await a.revokeDevice(devices.find((d) => !d.current)!.id);
    await expect(b.sync()).rejects.toBeInstanceOf(SessionExpiredError);
    await b.logout();
  });

  it("rejects requests without a valid token", async () => {
    const res = await fetch(`${url}/api/sync?since=0`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("rejects malformed item data", async () => {
    const { session: a } = await registerAlice();
    const token = (a as unknown as { state: { token: string } }).state.token;
    const res = await fetch(`${url}/api/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ changes: [{ id: crypto.randomUUID(), data: "plaintext!", deleted: false, baseRevision: 0 }] }),
    });
    expect(res.status).toBe(400);
  });
});
