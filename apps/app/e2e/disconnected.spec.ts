import { expect, test } from "@playwright/test";
import {
  STRONG_MASTER_PASSWORD,
  UNLOCK_TIMEOUT,
  addLogin,
  createAccount,
  field,
  openDevice,
  signInNewDevice,
  startServer,
  uniqueEmail,
  type TestServer,
} from "./harness";

let server: TestServer;
test.beforeAll(async () => {
  server = await startServer();
});
test.afterAll(async () => {
  await server?.stop();
});

const NEW_MASTER_PASSWORD = "Correct pony staple 42 & more";

test("Master password change on A → Device B shows Disconnected, never signed out", async ({ browser }) => {
  test.setTimeout(120_000);
  const account = { serverUrl: server.url, email: uniqueEmail(), masterPassword: STRONG_MASTER_PASSWORD };

  const deviceA = await openDevice(browser);
  await createAccount(deviceA, account);
  const deviceB = await signInNewDevice(browser, account);

  // Change the Master password on Device A.
  await deviceA.getByRole("button", { name: "Settings" }).click();
  await field(deviceA, "Current master password").fill(STRONG_MASTER_PASSWORD);
  await field(deviceA, "New master password").fill(NEW_MASTER_PASSWORD);
  await field(deviceA, "Confirm new master password").fill(NEW_MASTER_PASSWORD);
  await deviceA.getByRole("button", { name: "Change master password" }).click();
  await expect(deviceA.getByText("Master password changed.")).toBeVisible({ timeout: UNLOCK_TIMEOUT });

  // Device B syncs and learns it is Disconnected.
  const syncPill = deviceB.locator("button.sync-pill");
  await syncPill.click();
  await expect(syncPill).toHaveText(/Disconnected/);
  await expect(deviceB.locator(".banner", { hasText: "Disconnected" })).toBeVisible();

  // An edit made while Disconnected is kept and counted.
  await addLogin(deviceB, { name: "Made while Disconnected" });
  await expect(deviceB.locator(".banner", { hasText: "1 change waiting" })).toBeVisible();
  await expect(deviceB.locator("body")).not.toContainText(/signed out/i);

  // Signing in again with the new Master password uploads the change.
  await deviceB.locator(".banner", { hasText: "Sign in again" }).click();
  await field(deviceB, "Master password").fill(NEW_MASTER_PASSWORD);
  await deviceB.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(syncPill).toHaveText(/Synced/, { timeout: UNLOCK_TIMEOUT });
  await expect(deviceB.locator(".banner", { hasText: "Disconnected" })).toHaveCount(0);
});
