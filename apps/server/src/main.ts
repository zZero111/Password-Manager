import { join } from "node:path";
import { buildServer } from "./app";

const env = process.env;
const signups = env.SIGNUPS === "closed" ? "closed" : "open";
const dataDir = env.DATA_DIR ?? "./data";

const app = await buildServer({
  dbPath: join(dataDir, "vault.db"),
  signups,
  logger: env.LOG !== "off",
  trustProxy: env.TRUST_PROXY === "true",
});

const port = Number(env.PORT ?? 8080);
const host = env.HOST ?? "0.0.0.0";
await app.listen({ port, host });
app.log.info(`Sign-ups are ${signups}. Data directory: ${dataDir}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    app.close().finally(() => process.exit(0));
  });
}
