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

let oldServer: TestServer;
let newServer: TestServer;
test.beforeAll(async () => {
  oldServer = await startServer();
  newServer = await startServer();
});
test.afterAll(async () => {
  await oldServer?.stop();
  await newServer?.stop();
});

test("Settings shows Move to a new Server; a Move re-homes the Account and a new Device sees its Items", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail("move");
  const device = await openDevice(browser);
  await createAccount(device, { serverUrl: oldServer.url, email, masterPassword: STRONG_MASTER_PASSWORD });
  await addLogin(device, { name: "Moved item" });
  await device.getByRole("button", { name: "Settings" }).click();

  const form = device.getByRole("form", { name: "Move to a new Server" });
  const url = form.locator("label.field").filter({ hasText: "New Server URL" }).locator("input");
  const password = form.locator("label.field").filter({ hasText: "Master password" }).locator("input");
  const submit = form.getByRole("button", { name: "Move to new Server" });
  await expect(form.getByLabel("Delete my Account from the old Server afterwards")).toBeVisible();
  await expect(submit).toBeDisabled();

  await url.fill(newServer.url);
  await password.fill(STRONG_MASTER_PASSWORD);
  await form.getByLabel("Delete my Account from the old Server afterwards").check();
  await submit.click();
  await expect(form.getByRole("status")).toContainText("Moved 1 item", { timeout: UNLOCK_TIMEOUT });
  await expect(form.getByRole("status")).toContainText("deleted from the old Server");
  await expect(form.getByRole("status")).toContainText(`Your other Devices must sign in to ${newServer.url}`);

  const fresh = await signInNewDevice(browser, { serverUrl: newServer.url, email, masterPassword: STRONG_MASTER_PASSWORD });
  await expect(itemRow(fresh, "Moved item")).toBeVisible({ timeout: UNLOCK_TIMEOUT });
});
