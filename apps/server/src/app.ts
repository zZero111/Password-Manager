import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  type ChangePasswordRequest,
  type Device,
  KDF_MAX,
  KDF_MIN,
  LIMITS,
  type LoginRequest,
  type LoginResponse,
  type PreloginResponse,
  type PushRequest,
  type PushResponse,
  type RegisterRequest,
  type ServerItem,
  type SyncResponse,
} from "@pm/core/protocol";
import { type ItemRow, type SessionRow, type UserRow, openDatabase, transaction } from "./db";
import { FailureLimiter, burnTime, fakeSalt, hashAuthKey, hashToken, newToken, verifyAuthKey } from "./security";

export interface ServerOptions {
  dbPath: string;
  /** "open": anyone who can reach the server may register. "closed": no new accounts. */
  signups: "open" | "closed";
  logger?: boolean;
  trustProxy?: boolean;
  /** Login failures allowed per IP+email per 15 minutes. */
  maxLoginFailures?: number;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: { userId: string; sessionId: string };
  }
}

const DEFAULT_KDF = { algorithm: "argon2id", memoryKiB: 64 * 1024, iterations: 3, parallelism: 4 } as const;

// ── JSON schemas ──────────────────────────────────────────────────────

const email = { type: "string", minLength: 3, maxLength: LIMITS.maxEmail, pattern: "^[^\\s@]+@[^\\s@]+$" };
const b64 = (max: number) => ({ type: "string", minLength: 16, maxLength: max, pattern: "^[A-Za-z0-9+/]+={0,2}$" });
const cipher = (max: number) => ({ type: "string", maxLength: max, pattern: "^1\\.[A-Za-z0-9+/]+={0,2}\\.[A-Za-z0-9+/]+={0,2}$" });
const kdf = {
  type: "object",
  additionalProperties: false,
  required: ["algorithm", "memoryKiB", "iterations", "parallelism"],
  properties: {
    algorithm: { const: "argon2id" },
    memoryKiB: { type: "integer", minimum: KDF_MIN.memoryKiB, maximum: KDF_MAX.memoryKiB },
    iterations: { type: "integer", minimum: KDF_MIN.iterations, maximum: KDF_MAX.iterations },
    parallelism: { type: "integer", minimum: KDF_MIN.parallelism, maximum: KDF_MAX.parallelism },
  },
};
const body = (properties: Record<string, unknown>, extra: object = {}) => ({
  body: { type: "object", additionalProperties: false, required: Object.keys(properties), properties, ...extra },
});

// ── Server ────────────────────────────────────────────────────────────

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const db = openDatabase(opts.dbPath);
  const secret = serverSecret(db);
  const limiter = new FailureLimiter(opts.maxLoginFailures ?? 10, 15 * 60 * 1000);

  const app = Fastify({
    logger: opts.logger ? { redact: ["req.headers.authorization"] } : false,
    trustProxy: opts.trustProxy ?? false,
    bodyLimit: 64 * 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.addHook("onClose", async () => db.close());

  // Auth is a bearer token, never a cookie, so reflecting any origin is safe and
  // lets the desktop/mobile webviews (tauri://localhost etc.) talk to the server.
  await app.register(cors, { origin: true, methods: ["GET", "POST", "DELETE"], maxAge: 86400 });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    reply.status(status).send({ error: err.validation ? `Invalid request: ${err.message}` : status >= 500 ? "Internal error" : err.message });
  });

  const q = {
    userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    insertUser: db.prepare(
      "INSERT INTO users (id, email, salt, kdf, auth_hash, protected_key, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
    ),
    insertSession: db.prepare(
      "INSERT INTO sessions (id, user_id, token_hash, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    sessionByToken: db.prepare("SELECT * FROM sessions WHERE token_hash = ?"),
    touchSession: db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?"),
    deleteSession: db.prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?"),
    deleteOtherSessions: db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?"),
    listSessions: db.prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC"),
    itemsSince: db.prepare("SELECT id, data, deleted, revision FROM items WHERE user_id = ? AND revision > ? ORDER BY revision"),
    item: db.prepare("SELECT id, data, deleted, revision FROM items WHERE user_id = ? AND id = ?"),
    upsertItem: db.prepare(
      `INSERT INTO items (user_id, id, data, deleted, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, id) DO UPDATE SET data = excluded.data, deleted = excluded.deleted,
         revision = excluded.revision, updated_at = excluded.updated_at`,
    ),
    setRevision: db.prepare("UPDATE users SET revision = ? WHERE id = ?"),
    updatePassword: db.prepare("UPDATE users SET salt = ?, kdf = ?, auth_hash = ?, protected_key = ? WHERE id = ?"),
  };

  const toItem = (r: ItemRow): ServerItem => ({ id: r.id, data: r.data, deleted: r.deleted === 1, revision: r.revision });
  const now = () => new Date().toISOString();
  const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

  async function authenticate(req: FastifyRequest) {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const session = token ? (q.sessionByToken.get(hashToken(token)) as SessionRow | undefined) : undefined;
    if (!session) throw httpError(401, "Not signed in");
    // Only write last-seen once a minute to keep reads cheap.
    if (Date.now() - Date.parse(session.last_seen_at) > 60_000) q.touchSession.run(now(), session.id);
    req.auth = { userId: session.user_id, sessionId: session.id };
  }

  app.get("/health", async () => ({ ok: true }));
  app.get("/api/config", async () => ({ signups: opts.signups }));

  // ── Accounts ──

  app.post<{ Body: { email: string } }>(
    "/api/accounts/prelogin",
    { schema: body({ email }) },
    async (req): Promise<PreloginResponse> => {
      const e = req.body.email.toLowerCase();
      const user = q.userByEmail.get(e) as UserRow | undefined;
      if (user) return { kdf: JSON.parse(user.kdf), salt: user.salt };
      return { kdf: { ...DEFAULT_KDF }, salt: fakeSalt(secret, e) };
    },
  );

  app.post<{ Body: RegisterRequest }>(
    "/api/accounts/register",
    { schema: body({ email, authKey: b64(64), salt: b64(64), kdf, protectedKey: cipher(512) }) },
    async (req, reply) => {
      if (opts.signups !== "open") throw httpError(403, "Registration is closed on this server");
      const { authKey, salt, protectedKey } = req.body;
      const e = req.body.email.toLowerCase();
      if (q.userByEmail.get(e)) throw httpError(409, "An account with this email already exists");
      const id = randomUUID();
      q.insertUser.run(id, e, salt, JSON.stringify(req.body.kdf), await hashAuthKey(authKey), protectedKey, now());
      reply.status(201);
      return { userId: id };
    },
  );

  app.post<{ Body: LoginRequest }>(
    "/api/accounts/login",
    { schema: body({ email, authKey: b64(64), deviceName: { type: "string", minLength: 1, maxLength: LIMITS.maxDeviceName } }) },
    async (req): Promise<LoginResponse> => {
      const e = req.body.email.toLowerCase();
      const limitKey = `${req.ip}|${e}`;
      if (limiter.blocked(limitKey)) throw httpError(429, "Too many failed attempts. Try again in 15 minutes.");
      const user = q.userByEmail.get(e) as UserRow | undefined;
      const ok = user ? await verifyAuthKey(req.body.authKey, user.auth_hash) : (await burnTime(req.body.authKey), false);
      if (!user || !ok) {
        limiter.fail(limitKey);
        throw httpError(400, "Incorrect email or master password");
      }
      limiter.reset(limitKey);
      const token = newToken();
      const ts = now();
      q.insertSession.run(randomUUID(), user.id, hashToken(token), req.body.deviceName, ts, ts);
      return { token, userId: user.id, protectedKey: user.protected_key, kdf: JSON.parse(user.kdf), salt: user.salt };
    },
  );

  app.post("/api/accounts/logout", { preHandler: authenticate }, async (req, reply) => {
    q.deleteSession.run(req.auth.sessionId, req.auth.userId);
    reply.status(204);
  });

  app.post<{ Body: ChangePasswordRequest }>(
    "/api/accounts/password",
    {
      preHandler: authenticate,
      schema: body({ currentAuthKey: b64(64), authKey: b64(64), salt: b64(64), kdf, protectedKey: cipher(512) }),
    },
    async (req, reply) => {
      const user = q.userById.get(req.auth.userId) as unknown as UserRow;
      if (!(await verifyAuthKey(req.body.currentAuthKey, user.auth_hash))) {
        throw httpError(400, "Current master password is incorrect");
      }
      const { salt, authKey, protectedKey } = req.body;
      const authHash = await hashAuthKey(authKey);
      transaction(db, () => {
        q.updatePassword.run(salt, JSON.stringify(req.body.kdf), authHash, protectedKey, user.id);
        // Every other device must sign in again with the new password.
        q.deleteOtherSessions.run(user.id, req.auth.sessionId);
      });
      reply.status(204);
    },
  );

  // ── Devices ──

  app.get("/api/devices", { preHandler: authenticate }, async (req): Promise<Device[]> => {
    const rows = q.listSessions.all(req.auth.userId) as unknown as SessionRow[];
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      current: s.id === req.auth.sessionId,
    }));
  });

  app.delete<{ Params: { id: string } }>("/api/devices/:id", { preHandler: authenticate }, async (req, reply) => {
    const res = q.deleteSession.run(req.params.id, req.auth.userId);
    if (res.changes === 0) throw httpError(404, "Device not found");
    reply.status(204);
  });

  // ── Sync ──

  app.get<{ Querystring: { since: number } }>(
    "/api/sync",
    {
      preHandler: authenticate,
      schema: {
        querystring: {
          type: "object",
          required: ["since"],
          properties: { since: { type: "integer", minimum: 0 } },
        },
      },
    },
    async (req): Promise<SyncResponse> => {
      const user = q.userById.get(req.auth.userId) as unknown as UserRow;
      const rows = q.itemsSince.all(user.id, req.query.since) as unknown as ItemRow[];
      return { revision: user.revision, items: rows.map(toItem) };
    },
  );

  app.post<{ Body: PushRequest }>(
    "/api/sync",
    {
      preHandler: authenticate,
      schema: body({
        changes: {
          type: "array",
          maxItems: LIMITS.maxBatch,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "data", "deleted", "baseRevision"],
            properties: {
              id: { type: "string", format: "uuid" },
              data: cipher(LIMITS.maxItemBytes),
              deleted: { type: "boolean" },
              baseRevision: { type: "integer", minimum: 0 },
            },
          },
        },
      }),
    },
    async (req): Promise<PushResponse> => {
      const userId = req.auth.userId;
      return transaction(db, () => {
        const user = q.userById.get(userId) as unknown as UserRow;
        let revision = user.revision;
        const applied: PushResponse["applied"] = [];
        const conflicts: ServerItem[] = [];
        const ts = now();
        for (const c of req.body.changes) {
          const existing = q.item.get(userId, c.id) as ItemRow | undefined;
          if (existing && existing.revision !== c.baseRevision) {
            conflicts.push(toItem(existing));
            continue;
          }
          revision++;
          q.upsertItem.run(userId, c.id, c.data, c.deleted ? 1 : 0, revision, ts);
          applied.push({ id: c.id, revision });
        }
        if (revision !== user.revision) q.setRevision.run(revision, userId);
        return { applied, conflicts };
      });
    },
  );

  return app;
}

function serverSecret(db: DatabaseSync): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'secret'").get() as { value: string } | undefined;
  if (row) return row.value;
  const value = randomBytes(32).toString("base64");
  db.prepare("INSERT INTO meta (key, value) VALUES ('secret', ?)").run(value);
  return value;
}
