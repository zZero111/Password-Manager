import { expect, test } from "@playwright/test";
import {
  STRONG_MASTER_PASSWORD,
  UNLOCK_TIMEOUT,
  addLogin,
  createAccount,
  itemRow,
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

test("create Account → add Item → sign in on Device B → Item visible on B", async ({ browser }) => {
  const account = { serverUrl: server.url, email: uniqueEmail(), masterPassword: STRONG_MASTER_PASSWORD };

  const deviceA = await openDevice(browser);
  await createAccount(deviceA, account);
  await addLogin(deviceA, { name: "Smoke Login", username: "alice" });

  const deviceB = await signInNewDevice(browser, account);
  await expect(itemRow(deviceB, "Smoke Login")).toBeVisible({ timeout: UNLOCK_TIMEOUT });
});
