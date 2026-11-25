import { expect, test } from "@playwright/test";
import {
  STRONG_MASTER_PASSWORD,
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

test("Settings shows the Offline erase control, Off by default, and when the Server was last reached", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const device = await openDevice(browser);
  await createAccount(device, { serverUrl: server.url, email: uniqueEmail(), masterPassword: STRONG_MASTER_PASSWORD });
  await device.getByRole("button", { name: "Settings" }).click();

  const control = device
    .locator("label.field")
    .filter({ has: device.locator(".field-label", { hasText: "Offline erase (this Device only)" }) })
    .locator("select");
  await expect(control).toBeVisible();
  await expect(control).toHaveValue("0");
  await expect(control.locator("option:checked")).toHaveText("Off");
  await expect(control.locator("option")).toHaveText([
    "Off",
    "After 7 days offline",
    "After 14 days offline",
    "After 30 days offline",
    "After 90 days offline",
  ]);
  await expect(device.getByText("Last reached the Server:", { exact: false })).toBeVisible();
  await expect(device.getByText("Last reached the Server: never")).toHaveCount(0);

  // Turning it on is kept for this Device.
  device.on("dialog", (d) => void d.accept());
  await control.selectOption("14");
  await expect(control).toHaveValue("14");
});
