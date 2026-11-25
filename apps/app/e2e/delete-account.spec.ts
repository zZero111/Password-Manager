import { expect, test } from "@playwright/test";
import {
  STRONG_MASTER_PASSWORD,
  UNLOCK_TIMEOUT,
  createAccount,
  openDevice,
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

test("Settings shows Delete account with its confirmation; deleting shows the Account deleted notice", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const device = await openDevice(browser);
  const email = uniqueEmail();
  await createAccount(device, { serverUrl: server.url, email, masterPassword: STRONG_MASTER_PASSWORD });
  await device.getByRole("button", { name: "Settings" }).click();

  const form = device.getByRole("form", { name: "Delete account" });
  await expect(form.getByText("cannot be undone", { exact: false })).toBeVisible();
  const password = form.locator("label.field").filter({ hasText: "Master password" }).locator("input");
  const confirmation = form.locator("label.field").filter({ hasText: "Type your Account's email to confirm" }).locator("input");
  const submit = form.getByRole("button", { name: "Delete account permanently" });
  await expect(password).toBeVisible();
  await expect(confirmation).toBeVisible();
  await expect(submit).toBeDisabled();

  await password.fill(STRONG_MASTER_PASSWORD);
  await expect(submit).toBeDisabled();
  await confirmation.fill("DELETE");
  await expect(submit).toBeDisabled();
  await confirmation.fill(email.toUpperCase());
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(device.getByRole("alertdialog", { name: "Your Account was deleted" })).toBeVisible({
    timeout: UNLOCK_TIMEOUT,
  });
});
