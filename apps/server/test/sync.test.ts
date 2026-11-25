import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApiError,
  DeviceErasedError,
  DisconnectedError,
  type KdfParams,
  MIN_KDF,
  MemoryStorage,
  VaultSession,
  WrongPasswordError,
  buildExport,
  folders,
  newItemData,
  parseImport,
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
  it("propagates creates and edits between devices", async () => {
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
    expect(edited?.secretHistory[0]).toMatchObject({ field: { kind: "password" }, value: "hunter2" });

    // Secret history recorded on A reaches Device B.
    await a.save({ ...edited!, login: { ...edited!.login!, password: "third" } }, gh.id);
    await a.sync();
    await b.sync();
    expect((await b.get(gh.id))?.secretHistory.map((h) => h.value)).toEqual(["s3cret", "hunter2"]);
  });

  it("export → import into a fresh Account reproduces the live Vault", async () => {
    const { session: a } = await registerAlice();
    const gh = await a.save({ ...login_("GitHub"), folder: "Work" });
    await a.save({ ...gh, login: { ...gh.login!, password: "rotated" } }, gh.id);
    const gone = await a.save(login_("Old bank"));
    await a.delete(gone.id);
    await a.sync();

    const live = await a.list();
    const file = JSON.stringify(buildExport([...live.items, ...live.trash]));

    const bob = await VaultSession.register({
      serverUrl: url,
      email: "bob@example.com",
      password: PASSWORD,
      deviceName: "Bob's laptop",
      storage: new MemoryStorage(),
      kdf,
    });
    await bob.addMany(parseImport(file).items);
    await bob.sync();
    const bobOther = await VaultSession.login({
      serverUrl: url,
      email: "bob@example.com",
      password: PASSWORD,
      deviceName: "Bob's phone",
      storage: new MemoryStorage(),
    });
    await bobOther.sync();

    const strip = ({ id: _id, ...rest }: { id: string }) => rest;
    const imported = await bobOther.list();
    expect(imported.trash).toEqual([]);
    expect(live.items.map((i) => i.name)).toEqual(["GitHub"]);
    expect(imported.items.map(strip)).toEqual(live.items.map(strip));
    expect(imported.items[0]?.secretHistory.map((h) => h.value)).toEqual(["hunter2"]);
  });

  it("Delete on A → in B's Trash → Restore → back on both", async () => {
    const { session: a } = await registerAlice();
    const b = await login();
    const gh = await a.save({ ...login_("GitHub"), folder: "Work", fields: [{ name: "PIN", value: "1234", hidden: true }] });
    await a.sync();
    await b.sync();

    await a.delete(gh.id);
    await a.sync();
    await b.sync();
    const onB = await b.list();
    expect(onB.items).toHaveLength(0);
    expect(onB.trash.map((i) => i.name)).toEqual(["GitHub"]);
    expect(onB.trash[0]?.folder).toBe("Work");
    expect(onB.trash[0]?.fields).toEqual([{ name: "PIN", value: "1234", hidden: true }]);

    await b.restore(gh.id);
    await b.sync();
    await a.sync();
    for (const s of [a, b]) {
      const { items, trash } = await s.list();
      expect(trash).toHaveLength(0);
      expect(items.map((i) => [i.name, i.folder, i.login?.password])).toEqual([["GitHub", "Work", "hunter2"]]);
      expect(items[0]?.trashedAt).toBeUndefined();
    }
  });

  it("Delete permanently and Empty Trash Purge on every Device", async () => {
    const { session: a } = await registerAlice();
    const b = await login();
    const one = await a.save(login_("One"));
    const two = await a.save(login_("Two"));
    const three = await a.save(login_("Three"));
    await a.sync();
    await b.sync();

    // Delete permanently (Purge one)
    await a.delete(one.id);
    await a.purge(one.id);
    await a.sync();
    await b.sync();
    expect(await b.get(one.id)).toBeUndefined();
    expect((await b.list()).trash).toHaveLength(0);

    // Empty Trash, from the other Device
    await a.delete(two.id);
    await a.delete(three.id);
    await a.sync();
    await b.sync();
    expect((await b.list()).trash).toHaveLength(2);
    expect(await b.emptyTrash()).toBe(2);
    await b.sync();
    await a.sync();
    for (const s of [a, b]) expect(await s.list()).toEqual({ items: [], trash: [], unreadable: 0 });
  });

  it("Purged on day 31, still in Trash on day 29", async () => {
    let t = Date.parse("2031-03-01T09:00:00Z");
    const now = () => new Date(t);
    const DAY = 24 * 60 * 60 * 1000;
    const aStorage = new MemoryStorage();
    const opts = { serverUrl: url, email: "alice@example.com", password: PASSWORD, now };
    const a = await VaultSession.register({ ...opts, deviceName: "Device A", storage: aStorage, kdf });
    const b = await VaultSession.login({ ...opts, deviceName: "Device B", storage: new MemoryStorage() });
    const item = await a.save(login_("Old"));
    await a.delete(item.id);
    await a.sync();

    t += 29 * DAY;
    expect((await b.sync()).purged).toBe(0);
    expect((await b.list()).trash.map((i) => i.name)).toEqual(["Old"]);

    t += 2 * DAY; // day 31
    expect((await b.sync()).purged).toBe(1);
    expect(await b.get(item.id)).toBeUndefined();
    // The Purge reached the other Device too (A unlocked fresh with the same clock).
    const again = await VaultSession.unlock(aStorage, PASSWORD, undefined, { now });
    await again.sync();
    expect(await again.get(item.id)).toBeUndefined();
    expect((await again.list()).trash).toHaveLength(0);
  });

  it("a Delete on one Device and an edit on another: most recent change wins", async () => {
    const { session: a } = await registerAlice();
    const b = await login();
    const first = await a.save(login_("Edited last"));
    const second = await a.save(login_("Deleted last"));
    await a.sync();
    await b.sync();
    const tick = () => new Promise((r) => setTimeout(r, 5));

    // A Deletes, then B edits later: the edit wins and the Item stays live.
    await a.delete(first.id);
    await tick();
    await b.save({ ...first, notes: "kept" }, first.id);
    // B edits, then A Deletes later: the Delete wins and the Item is in the Trash.
    await b.save({ ...second, notes: "lost" }, second.id);
    await tick();
    await a.delete(second.id);

    await a.sync();
    await b.sync();
    await a.sync();
    for (const s of [a, b]) {
      const { items, trash } = await s.list();
      expect(items.map((i) => [i.name, i.notes])).toEqual([["Edited last", "kept"]]);
      expect(trash.map((i) => i.name)).toEqual(["Deleted last"]);
      expect(s.pendingCount).toBe(0);
    }
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

  it("remote wins keeps local password", async () => {
    const { session: a } = await registerAlice();
    const b = await login();
    const item = await a.save(login_("Email", "p1"));
    await a.sync();
    await b.sync();

    // B changes the password offline; A edits notes later, so A wins.
    await b.save({ ...item, login: { ...item.login!, password: "p2" } }, item.id);
    await new Promise((r) => setTimeout(r, 5));
    await a.save({ ...item, notes: "from A" }, item.id);
    await a.sync();
    const res = await b.sync();
    expect(res.conflicts).toBeGreaterThan(0);
    await a.sync();

    for (const d of [a, b]) {
      const got = await d.get(item.id);
      expect(got?.notes).toBe("from A");
      expect(got?.login?.password).toBe("p1");
      expect(got?.secretHistory[0]).toMatchObject({ field: { kind: "password" }, value: "p2", fromConflict: true });
    }
    expect(a.pendingCount + b.pendingCount).toBe(0);
  });

  it("local wins keeps remote Authenticator key", async () => {
    const { session: a } = await registerAlice();
    const b = await login();
    const item = await a.save(login_("Email"));
    await a.sync();
    await b.sync();

    // A sets an Authenticator key offline; B edits notes later, so B wins.
    await a.save({ ...item, login: { ...item.login!, totp: "JBSWY3DPEHPK3PXP" } }, item.id);
    await new Promise((r) => setTimeout(r, 5));
    await b.save({ ...item, notes: "from B" }, item.id);
    await a.sync(); // A pushes first and is accepted
    const res = await b.sync(); // B's change is newer: B wins, keeps A's key in history
    expect(res.conflicts).toBeGreaterThan(0);
    await a.sync();

    for (const d of [a, b]) {
      const got = await d.get(item.id);
      expect(got?.notes).toBe("from B");
      expect(got?.login?.totp).toBe("");
      expect(got?.secretHistory[0]).toMatchObject({ field: { kind: "totp" }, value: "JBSWY3DPEHPK3PXP", fromConflict: true });
    }
    expect(a.pendingCount + b.pendingCount).toBe(0);
  });

  it("a Conflict where no secret changed adds no Secret history", async () => {
    const { session: a } = await registerAlice();
    const b = await login();
    const item = await a.save(login_("Email"));
    await a.sync();
    await b.sync();

    await a.save({ ...item, notes: "from A" }, item.id);
    await new Promise((r) => setTimeout(r, 5));
    await b.save({ ...item, notes: "from B" }, item.id);
    await a.sync();
    expect((await b.sync()).conflicts).toBeGreaterThan(0);
    await a.sync();

    for (const d of [a, b]) expect((await d.get(item.id))?.secretHistory).toEqual([]);
    expect(a.pendingCount + b.pendingCount).toBe(0);
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

describe("folders", () => {
  it("rename syncs to Device B", async () => {
    const { session: a } = await registerAlice();
    const b = await login();
    await a.save({ ...login_("GitHub"), folder: "Work" });
    await a.save({ ...login_("Jira"), folder: " work " });
    const old = await a.save({ ...login_("Old VPN"), folder: "WORK" });
    await a.save({ ...login_("Bank"), folder: "Personal" });
    await a.delete(old.id);
    await a.sync();
    await b.sync();

    expect(await a.renameFolder("work", "Job")).toBe(3);
    await a.sync();
    await b.sync();
    for (const s of [a, b]) {
      const { items, trash } = await s.list();
      const byName = Object.fromEntries([...items, ...trash].map((i) => [i.name, i.folder]));
      expect(byName).toEqual({ GitHub: "Job", Jira: "Job", "Old VPN": "Job", Bank: "Personal" });
      expect(trash.map((i) => i.name)).toEqual(["Old VPN"]);
      expect(folders(items)).toEqual(["Job", "Personal"]);
    }
  });

  it("rename onto an existing Folder merges", async () => {
    const { session: a } = await registerAlice();
    const b = await login();
    await a.save({ ...login_("GitHub"), folder: "Work" });
    await a.save({ ...login_("Bank"), folder: "Personal" });
    await a.sync();

    expect(await a.renameFolder("Work", " personal")).toBe(1);
    await a.sync();
    await b.sync();
    for (const s of [a, b]) {
      const { items } = await s.list();
      expect(folders(items)).toEqual(["Personal"]);
      expect(items.map((i) => i.folder)).toEqual(["Personal", "Personal"]);
    }
  });
});

describe("zero-knowledge storage", () => {
  it("the server database never contains plaintext", async () => {
    const { session: a, storage } = await registerAlice();
    await a.save(login_("Super Secret Bank", "PLAINTEXT-PASSWORD-123"));
    await a.sync();
    // A Trash Item whose trash date is distinctive enough to spot in a dump.
    const trashDate = "2031-07-04T12:34:56.789Z";
    const unlocked = await VaultSession.unlock(storage, PASSWORD, undefined, { now: () => new Date(trashDate) });
    const gone = await unlocked.save(login_("Trashed"));
    await unlocked.delete(gone.id);
    expect((await unlocked.get(gone.id))?.trashedAt).toBe(trashDate);
    await unlocked.sync();
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
    expect(dump).not.toContain("2031-07-04");
    expect(dump).not.toContain(String(Date.parse(trashDate)));
    expect(dump).not.toMatch(/trash/i);
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
  it("Master password change → Device B Disconnected, pending kept, uploaded after signing in again", async () => {
    const { session: a } = await registerAlice();
    const bStorage = new MemoryStorage();
    const b = await login(bStorage);
    const item = await a.save(login_("Shop"));
    await a.sync();
    await b.sync();

    await a.changePassword(PASSWORD, "a brand new master password");
    await b.save({ ...item, notes: "edited on B while Disconnected" }, item.id);
    const err = await b.sync().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DisconnectedError);
    expect((err as DisconnectedError).reason).toBe("disconnected");
    expect(b.signedIn).toBe(false);
    expect(b.pendingCount).toBe(1);
    expect((await b.get(item.id))?.notes).toBe("edited on B while Disconnected");

    await expect(b.reauthenticate(PASSWORD)).rejects.toBeInstanceOf(ApiError);
    await b.reauthenticate("a brand new master password");
    await b.sync();
    await a.sync();
    expect(b.pendingCount).toBe(0);
    expect((await a.get(item.id))?.notes).toBe("edited on B while Disconnected");

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
    expect((await a.devices()).map((d) => d.name)).toEqual(["Device A"]);
  });

  it("rejects requests without a valid token", async () => {
    const res = await fetch(`${url}/api/sync?since=0`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in", reason: "disconnected" });
    const none = await fetch(`${url}/api/sync?since=0`);
    expect(none.status).toBe(401);
    expect((await none.json()).reason).toBe("disconnected");
  });

  it("unknown token reports Disconnected", async () => {
    await registerAlice();
    const b = await login();
    const item = await b.save(login_("Kept"));
    // The Server forgets B's token without recording why (e.g. restored from an older backup).
    const db = new DatabaseSync(dbPath);
    db.prepare("DELETE FROM sessions WHERE name = 'Device B'").run();
    db.close();
    const err = await b.sync().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DisconnectedError);
    expect((err as DisconnectedError).reason).toBe("disconnected");
    expect(b.pendingCount).toBe(1);
    expect((await b.get(item.id))?.name).toBe("Kept");
  });

  it("a logged-out or removed token gets reason signed_out on the wire", async () => {
    const { session: a } = await registerAlice();
    const b = await login();
    const c = await login(new MemoryStorage(), "Device C");
    const tokenOf = (s: VaultSession) => (s as unknown as { state: { token: string } }).state.token;
    const bToken = tokenOf(b);
    const cToken = tokenOf(c);

    const logout = await fetch(`${url}/api/accounts/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${bToken}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(logout.status).toBe(204);
    const devices = await a.devices();
    await a.revokeDevice(devices.find((d) => d.name === "Device C")!.id);

    for (const token of [bToken, cToken]) {
      const res = await fetch(`${url}/api/sync?since=0`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Not signed in", reason: "signed_out" });
    }

    // A Master password change marks the remaining other Devices disconnected, not signed_out.
    const d = await login(new MemoryStorage(), "Device D");
    await a.changePassword(PASSWORD, "a brand new master password");
    const res = await fetch(`${url}/api/sync?since=0`, { headers: { authorization: `Bearer ${tokenOf(d)}` } });
    expect((await res.json()).reason).toBe("disconnected");
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

describe("check device", () => {
  const signOutB = async (a: VaultSession) => {
    const devices = await a.devices();
    await a.revokeDevice(devices.find((d) => d.name === "Device B")!.id);
  };

  it("check device on Locked B after Sign out → B's storage empty", async () => {
    const { session: a } = await registerAlice();
    const bStorage = new MemoryStorage();
    const b = await login(bStorage);
    await b.save(login_("Unsynced on B"));
    b.lock();
    await signOutB(a);
    // Only B's storage: no Master password, no unlocked session.
    expect(await VaultSession.checkDevice(bStorage)).toBe("signedOut");
    expect(await bStorage.load()).toBeNull();
    expect(await VaultSession.checkDevice(bStorage)).toBe("noVault");
  });

  it("Master password change → B Disconnected, not erased", async () => {
    const { session: a } = await registerAlice();
    const bStorage = new MemoryStorage();
    const b = await login(bStorage);
    const item = await b.save(login_("Pending on B"));
    b.lock();
    await a.changePassword(PASSWORD, "a brand new master password");
    expect(await VaultSession.checkDevice(bStorage)).toBe("disconnected");
    const kept = await bStorage.load();
    expect(kept).not.toBeNull();
    expect(kept!.token).toBeNull();
    expect(Object.keys(kept!.pending)).toEqual([item.id]);
    // Still unlocks offline with the password it was stored under; the edit is there.
    const again = await VaultSession.unlock(bStorage, PASSWORD);
    expect((await again.get(item.id))?.name).toBe("Pending on B");
    expect(await VaultSession.checkDevice(bStorage)).toBe("disconnected");
  });

  it("check device while offline → unchanged", async () => {
    const { session: a } = await registerAlice();
    const bStorage = new MemoryStorage();
    await login(bStorage);
    await signOutB(a);
    const before = await bStorage.load();
    await app.close();
    expect(await VaultSession.checkDevice(bStorage)).toBe("offline");
    expect(await bStorage.load()).toEqual(before);
    await start(); // afterEach closes it again
  });

  it("accepted contact records lastReachedServer", async () => {
    await registerAlice();
    const bStorage = new MemoryStorage();
    const b = await login(bStorage);
    const t1 = new Date("2030-01-02T03:04:05.000Z");
    expect(await VaultSession.checkDevice(bStorage, undefined, { now: () => t1 })).toBe("accepted");
    expect((await bStorage.load())!.lastReachedServer).toBe(t1.toISOString());
    expect((await bStorage.load())!.token).not.toBeNull();

    // An unlocked session records it after every successful Server call too.
    const t2 = new Date("2030-02-03T04:05:06.000Z");
    const unlocked = await VaultSession.unlock(bStorage, PASSWORD, undefined, { now: () => t2 });
    await unlocked.sync();
    expect(unlocked.lastReachedServer).toBe(t2.toISOString());
    expect((await bStorage.load())!.lastReachedServer).toBe(t2.toISOString());
    b.lock();
  });

  it("unlocked B receiving signed_out during sync → erased + locked", async () => {
    const { session: a } = await registerAlice();
    const bStorage = new MemoryStorage();
    const b = await login(bStorage);
    await b.save(login_("Unsynced on B"));
    await signOutB(a);
    await expect(b.sync()).rejects.toBeInstanceOf(DeviceErasedError);
    expect(b.erased).toBe(true);
    expect(b.locked).toBe(true);
    expect(b.signedIn).toBe(false);
    expect(await bStorage.load()).toBeNull();
    // Nothing writes the vault back afterwards.
    await expect(b.save(login_("after"))).rejects.toThrow();
    await expect(b.devices()).rejects.toBeInstanceOf(DeviceErasedError);
    expect(await bStorage.load()).toBeNull();
  });
});

describe("offline erase", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const day0 = new Date("2030-01-01T00:00:00.000Z").getTime();
  const day = (n: number) => () => new Date(day0 + n * DAY);
  const stopServer = async () => {
    await app.close();
  };

  /** B signed in, Offline erase set to `days` and the Server last reached on day 0. */
  async function deviceB(days: 14 | null) {
    await registerAlice();
    const bStorage = new MemoryStorage();
    (await login(bStorage)).lock();
    const b = await VaultSession.unlock(bStorage, PASSWORD, undefined, { now: day(0) });
    await b.setOfflineErase(days);
    await b.sync();
    b.lock();
    return bStorage;
  }

  it("is Off by default on a new Device", async () => {
    await registerAlice();
    const bStorage = new MemoryStorage();
    const b = await login(bStorage);
    expect(b.offlineEraseDays).toBeNull();
    expect((await bStorage.load())!.offlineEraseDays).toBeUndefined();
    b.lock();
    await stopServer();
    // Off: years offline still keeps the vault.
    expect(await VaultSession.checkDevice(bStorage, undefined, { now: day(5000) })).toBe("offline");
    expect(await bStorage.load()).not.toBeNull();
    await start();
  });

  it("14-day limit, offline on day 15 → erased", async () => {
    const bStorage = await deviceB(14);
    expect((await bStorage.load())!.offlineEraseDays).toBe(14);
    await stopServer();
    expect(await VaultSession.checkDevice(bStorage, undefined, { now: day(15) })).toBe("offlineErased");
    expect(await bStorage.load()).toBeNull();
    expect(await VaultSession.checkDevice(bStorage, undefined, { now: day(15) })).toBe("noVault");
    await start();
  });

  it("14-day limit, offline on day 13 → kept", async () => {
    const bStorage = await deviceB(14);
    const before = await bStorage.load();
    await stopServer();
    expect(await VaultSession.checkDevice(bStorage, undefined, { now: day(13) })).toBe("offline");
    expect(await bStorage.load()).toEqual(before);
    await start();
  });

  it("past the limit but the Server is reachable → not erased, countdown reset", async () => {
    const bStorage = await deviceB(14);
    expect(await VaultSession.checkDevice(bStorage, undefined, { now: day(30) })).toBe("accepted");
    const kept = await bStorage.load();
    expect(kept).not.toBeNull();
    expect(kept!.lastReachedServer).toBe(day(30)().toISOString());
  });

  it("reaching the Server resets the count", async () => {
    const bStorage = await deviceB(14);
    expect(await VaultSession.checkDevice(bStorage, undefined, { now: day(10) })).toBe("accepted");
    await stopServer();
    // Day 20 is 20 days after setup but only 10 after the Server was last reached.
    expect(await VaultSession.checkDevice(bStorage, undefined, { now: day(20) })).toBe("offline");
    expect(await bStorage.load()).not.toBeNull();
    expect(await VaultSession.checkDevice(bStorage, undefined, { now: day(25) })).toBe("offlineErased");
    expect(await bStorage.load()).toBeNull();
    await start();
  });

  it("no lastReachedServer (older vault) → counts from when it was turned on", async () => {
    const bStorage = await deviceB(null);
    const { lastReachedServer: _, ...old } = (await bStorage.load())!;
    await bStorage.save(old);
    const b = await VaultSession.unlock(bStorage, PASSWORD, undefined, { now: day(100) });
    await b.setOfflineErase(14);
    b.lock();
    await stopServer();
    expect(await VaultSession.checkDevice(bStorage, undefined, { now: day(110) })).toBe("offline");
    expect(await VaultSession.checkDevice(bStorage, undefined, { now: day(115) })).toBe("offlineErased");
    await start();
  });
});

describe("account deletion", () => {
  const rowsFor = (userId: string) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const count = (table: string, col: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(userId) as { n: number }).n;
    const rows = { users: count("users", "id"), sessions: count("sessions", "user_id"), items: count("items", "user_id") };
    db.close();
    return rows;
  };
  const aliceId = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT id FROM users WHERE email = ?").get("alice@example.com") as { id: string };
    db.close();
    return row.id;
  };

  it("wrong Master password fails and changes nothing", async () => {
    const { session: a, storage } = await registerAlice();
    await a.save(login_("Kept"));
    await a.sync();
    const id = aliceId();
    const before = rowsFor(id);
    await expect(a.deleteAccount("not my master password")).rejects.toThrow(/incorrect/i);
    expect(rowsFor(id)).toEqual(before);
    expect(before).toEqual({ users: 1, sessions: 1, items: 1 });
    expect(await storage.load()).not.toBeNull();
    expect(a.locked).toBe(false);
    await a.sync();
  });

  it("correct Master password leaves no rows for the Account and erases this Device", async () => {
    const { session: a, storage } = await registerAlice();
    await login();
    await a.save(login_("Gone"));
    await a.sync();
    const id = aliceId();
    expect(rowsFor(id)).toEqual({ users: 1, sessions: 2, items: 1 });
    await a.deleteAccount(PASSWORD);
    expect(rowsFor(id)).toEqual({ users: 0, sessions: 0, items: 0 });
    expect(await storage.load()).toBeNull();
    expect(a.locked).toBe(true);
  });

  it("another Device of the Account erases itself on its next check device", async () => {
    const { session: a } = await registerAlice();
    const bStorage = new MemoryStorage();
    const b = await login(bStorage);
    await b.save(login_("Unsynced on B"));
    b.lock();
    await a.deleteAccount(PASSWORD);
    expect(await VaultSession.checkDevice(bStorage)).toBe("signedOut");
    expect(await bStorage.load()).toBeNull();
  });

  it("the same email can register again afterwards", async () => {
    const { session: a } = await registerAlice();
    await a.deleteAccount(PASSWORD);
    const { session: again } = await registerAlice();
    expect(again.email).toBe("alice@example.com");
    expect((await again.list()).items).toEqual([]);
  });
});

describe("move", () => {
  async function startSecond(signups: "open" | "closed" = "open") {
    const path = join(mkdtempSync(join(tmpdir(), "pm-")), "vault.db");
    const server = await buildServer({ dbPath: path, signups, maxLoginFailures: 5 });
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    return { server, url: `http://127.0.0.1:${addr.port}` };
  }
  const loginAt = (serverUrl: string, password = PASSWORD) =>
    VaultSession.login({ serverUrl, email: "alice@example.com", password, deviceName: "Fresh", storage: new MemoryStorage() });
  const names = (list: { name: string }[]) => list.map((i) => i.name).sort();

  it("a fresh Device signs in to the new Server and sees every Item, including the Trash", async () => {
    const second = await startSecond();
    try {
      const { session: a, storage } = await registerAlice();
      await a.save(login_("Live"));
      const trashed = await a.save(login_("Binned"));
      const purged = await a.save(login_("Purged"));
      await a.sync();
      await a.delete(trashed.id);
      await a.purge(purged.id);
      await a.sync();

      const res = await a.moveTo({ serverUrl: second.url, masterPassword: PASSWORD, deleteOld: false });
      expect(res).toEqual({ uploaded: 2, oldAccountDeleted: false });
      expect(a.serverUrl).toBe(second.url);
      expect((await storage.load())!.serverUrl).toBe(second.url);

      const fresh = await loginAt(second.url);
      const list = await fresh.list();
      expect(names(list.items)).toEqual(["Live"]);
      expect(names(list.trash)).toEqual(["Binned"]);
      expect(list.unreadable).toBe(0);

      // The moved Device keeps syncing with the new Server, both ways.
      await a.save(login_("After move"));
      expect((await a.sync()).pushed).toBe(1);
      await fresh.sync();
      expect(names((await fresh.list()).items)).toEqual(["After move", "Live"]);
      // The old Account was left alone.
      expect(names((await (await login()).list()).items)).toEqual(["Live"]);
    } finally {
      await second.server.close();
    }
  });

  it("pending local changes on the moving Device arrive on the new Server", async () => {
    const second = await startSecond();
    try {
      const { session: a } = await registerAlice();
      const synced = await a.save(login_("Synced"));
      await a.sync();
      await app.close(); // old Server goes away: edits stay pending
      await a.save({ ...synced, name: "Edited offline" }, synced.id);
      await a.save(login_("Created offline"));
      await expect(a.sync()).rejects.toThrow();
      expect(a.pendingCount).toBe(2);

      const res = await a.moveTo({ serverUrl: second.url, masterPassword: PASSWORD, deleteOld: true });
      expect(res.uploaded).toBe(2);
      expect(res.oldAccountDeleted).toBe(false);
      expect(res.oldAccountError).toBeTruthy();
      expect(a.pendingCount).toBe(0);

      const fresh = await loginAt(second.url);
      expect(names((await fresh.list()).items)).toEqual(["Created offline", "Edited offline"]);
      expect((await a.sync()).pulled).toBe(2);
      await start(); // so afterEach has a Server to close
    } finally {
      await second.server.close();
    }
  });

  it("uploads in batches the Server accepts", async () => {
    const second = await startSecond();
    try {
      const { session: a } = await registerAlice();
      await a.addMany(Array.from({ length: 501 }, (_, i) => login_(`Item ${i}`)));
      const res = await a.moveTo({ serverUrl: second.url, masterPassword: PASSWORD, deleteOld: false });
      expect(res.uploaded).toBe(501);
      expect((await (await loginAt(second.url)).list()).items).toHaveLength(501);
    } finally {
      await second.server.close();
    }
  });

  it("with the delete option, the Account is gone from the old Server", async () => {
    const second = await startSecond();
    try {
      const { session: a } = await registerAlice();
      await a.save(login_("Moved"));
      await a.sync();
      const res = await a.moveTo({ serverUrl: second.url, masterPassword: PASSWORD, deleteOld: true });
      expect(res).toEqual({ uploaded: 1, oldAccountDeleted: true });
      await expect(login()).rejects.toThrow(/Incorrect/);
      expect(names((await (await loginAt(second.url)).list()).items)).toEqual(["Moved"]);
    } finally {
      await second.server.close();
    }
  });

  it("with the old Server down, the Move succeeds and reports the skipped deletion", async () => {
    const second = await startSecond();
    try {
      const { session: a } = await registerAlice();
      await a.save(login_("Moved"));
      await a.sync();
      await app.close();
      const res = await a.moveTo({ serverUrl: second.url, masterPassword: PASSWORD, deleteOld: true });
      expect(res.uploaded).toBe(1);
      expect(res.oldAccountDeleted).toBe(false);
      expect(res.oldAccountError).toMatch(/\S/);
      expect(a.serverUrl).toBe(second.url);
      await a.sync();
      await start();
    } finally {
      await second.server.close();
    }
  });

  it("a wrong Master password, closed sign-ups or an existing email fail without changing this Device", async () => {
    const closed = await startSecond("closed");
    const taken = await startSecond();
    try {
      const { session: a, storage } = await registerAlice();
      await a.save(login_("Stays"));
      await a.sync();
      await a.save(login_("Pending"));
      const before = structuredClone(await storage.load());

      await expect(a.moveTo({ serverUrl: taken.url, masterPassword: "wrong", deleteOld: true })).rejects.toThrow(/Incorrect/i);
      await expect(a.moveTo({ serverUrl: closed.url, masterPassword: PASSWORD, deleteOld: true })).rejects.toThrow(/closed/i);
      await VaultSession.register({
        serverUrl: taken.url, email: "alice@example.com", password: "someone else's", deviceName: "X", storage: new MemoryStorage(), kdf,
      });
      await expect(a.moveTo({ serverUrl: taken.url, masterPassword: PASSWORD, deleteOld: true })).rejects.toThrow(/already exists/);
      await expect(
        a.moveTo({ serverUrl: "http://127.0.0.1:1", masterPassword: PASSWORD, deleteOld: true }),
      ).rejects.toThrow();

      expect(await storage.load()).toEqual(before);
      expect(a.serverUrl).toBe(url);
      expect((await a.sync()).pushed).toBe(1);
      expect(names((await (await login()).list()).items)).toEqual(["Pending", "Stays"]);
    } finally {
      await closed.server.close();
      await taken.server.close();
    }
  });
});
