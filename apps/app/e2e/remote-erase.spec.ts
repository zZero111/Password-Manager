import { expect, test } from "@playwright/test";
import {
  STRONG_MASTER_PASSWORD,
  UNLOCK_TIMEOUT,
  createAccount,
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

test("Sign out a Locked Device B from A → B erases itself when it next reaches the Server", async ({ browser }) => {
  test.setTimeout(120_000);
  const account = { serverUrl: server.url, email: uniqueEmail(), masterPassword: STRONG_MASTER_PASSWORD };

  const deviceA = await openDevice(browser);
  await createAccount(deviceA, account);
  const deviceB = await signInNewDevice(browser, account);

  // Lock B: no Master password is held on it from here on.
  await deviceB.getByRole("button", { name: "Lock (Ctrl+L)" }).click();
  await expect(deviceB.getByRole("button", { name: "Unlock" })).toBeVisible();

  // On A, the Devices list explains what Signing out another Device does, then sign out B.
  await deviceA.getByRole("button", { name: "Settings" }).click();
  await expect(
    deviceA.getByText("Signing out another Device erases its vault the next time it goes online"),
  ).toBeVisible();
  await expect(deviceA.getByText("Until then it keeps its encrypted copy.", { exact: false })).toBeVisible();
  deviceA.on("dialog", (d) => void d.accept());
  const signOutB = deviceA.locator(".device").getByRole("button", { name: "Sign out" });
  await expect(signOutB).toHaveCount(1, { timeout: UNLOCK_TIMEOUT });
  await signOutB.click();
  await expect(signOutB).toHaveCount(0);

  // B relaunches while Locked: check device runs and erases it.
  await deviceB.reload();
  await expect(deviceB.getByText("This Device was signed out and its vault erased")).toBeVisible({
    timeout: UNLOCK_TIMEOUT,
  });
  await deviceB.getByRole("button", { name: "Continue" }).click();
  await expect(deviceB.getByRole("tab", { name: "Sign in" })).toBeVisible();

  // Erased for good: another reload goes straight to Welcome, not the Unlock screen.
  await deviceB.reload();
  await expect(deviceB.getByRole("tab", { name: "Sign in" })).toBeVisible();
  await expect(deviceB.getByRole("button", { name: "Unlock" })).toHaveCount(0);
});
