// Reusable helpers for UI smoke tests: a throwaway Server, Account creation, and Devices.
// A "Device" here is a fresh Playwright browser context (its own storage), opened on the built app.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Browser, type Locator, type Page } from "@playwright/test";

const SERVER_BUNDLE = join(dirname(fileURLToPath(import.meta.url)), "../../server/dist/server.js");

/** Key derivation (Argon2id) takes a few seconds, so post-login waits get a generous timeout. */
export const UNLOCK_TIMEOUT = 30_000;

/** A master password that passes the Welcome screen's length and strength checks. */
export const STRONG_MASTER_PASSWORD = "Tr0ub4dor & horse battery 9";

export interface TestServer {
  url: string;
  stop(): Promise<void>;
}

export interface AccountCredentials {
  serverUrl: string;
  email: string;
  masterPassword: string;
}

/** A unique email per call so tests never collide on the same Server. */
export function uniqueEmail(prefix = "smoke"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start a throwaway Server from the built bundle (apps/server/dist/server.js) with an empty
 * data directory on a free port. Call `stop()` to kill it and delete its data.
 */
export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const dataDir = await mkdtemp(join(tmpdir(), "keyhold-smoke-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", SERVER_BUNDLE],
    { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, LOG: "off", ...env }, stdio: ["ignore", "inherit", "inherit"] },
  );
  let exited = false;
  child.on("exit", () => (exited = true));

  const deadline = Date.now() + 15_000;
  for (;;) {
    if (exited) throw new Error(`Server exited during startup (is ${SERVER_BUNDLE} built?)`);
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`Server did not become healthy at ${url}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    url,
    async stop() {
      if (!exited) {
        const done = new Promise((r) => child.once("exit", r));
        child.kill("SIGTERM");
        await done;
      }
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** The input inside a `Field` whose visible label is exactly `label`. */
export function field(page: Page, label: string): Locator {
  return page
    .locator("label.field")
    .filter({ has: page.locator(".field-label", { hasText: new RegExp(`^${label}$`) }) })
    .locator("input, textarea")
    .first();
}

/** Open a new Device: a fresh browser context showing the app's Welcome screen. */
export async function openDevice(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  return page;
}

async function expectVaultScreen(page: Page): Promise<void> {
  await expect(page.getByPlaceholder("Search vault")).toBeVisible({ timeout: UNLOCK_TIMEOUT });
}

/** On a Device's Welcome screen, create an Account and wait for its (empty) Vault. */
export async function createAccount(page: Page, account: AccountCredentials): Promise<void> {
  await page.getByRole("tab", { name: "Create account" }).click();
  await field(page, "Server URL").fill(account.serverUrl);
  await field(page, "Email").fill(account.email);
  await field(page, "Master password").fill(account.masterPassword);
  await field(page, "Confirm master password").fill(account.masterPassword);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expectVaultScreen(page);
}

/** On a Device's Welcome screen, sign in to an existing Account and wait for its Vault. */
export async function signIn(page: Page, account: AccountCredentials): Promise<void> {
  await page.getByRole("tab", { name: "Sign in" }).click();
  await field(page, "Server URL").fill(account.serverUrl);
  await field(page, "Email").fill(account.email);
  await field(page, "Master password").fill(account.masterPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expectVaultScreen(page);
}

/** Open a new Device and sign in to `account` on it. */
export async function signInNewDevice(browser: Browser, account: AccountCredentials): Promise<Page> {
  const page = await openDevice(browser);
  await signIn(page, account);
  return page;
}

/** On an unlocked Device, add a Login Item and wait for it to appear in the list. */
export async function addLogin(page: Page, login: { name: string; username?: string }): Promise<void> {
  await page.getByRole("button", { name: "New item" }).click();
  await page.locator(".menu").getByRole("button", { name: "Login" }).click();
  await page.getByLabel("Name", { exact: true }).fill(login.name);
  if (login.username !== undefined) await page.getByLabel("Username", { exact: true }).fill(login.username);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(itemRow(page, login.name)).toBeVisible();
}

/** The row for an Item in a Device's Item list. */
export function itemRow(page: Page, name: string): Locator {
  return page.locator(".item-row").filter({ hasText: name });
}
