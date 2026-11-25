import { expect, test } from "@playwright/test";
import { STRONG_MASTER_PASSWORD, addLogin, createAccount, itemRow, openDevice, startServer, uniqueEmail, type TestServer } from "./harness";

let server: TestServer;
test.beforeAll(async () => {
  server = await startServer();
});
test.afterAll(async () => {
  await server?.stop();
});

test("Delete → Trash view → Restore → Empty Trash", async ({ browser }) => {
  test.setTimeout(120_000);
  const account = { serverUrl: server.url, email: uniqueEmail(), masterPassword: STRONG_MASTER_PASSWORD };
  const page = await openDevice(browser);
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.accept();
  });
  await createAccount(page, account);
  await addLogin(page, { name: "Alpha", username: "alice" });
  await addLogin(page, { name: "Bravo", username: "bob" });

  const nav = (label: string) => page.locator("nav .nav-item", { hasText: label });
  const search = page.getByRole("searchbox");

  // Delete moves Alpha to the Trash: gone from All items and from search.
  await itemRow(page, "Alpha").click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(itemRow(page, "Alpha")).toHaveCount(0);
  await search.fill("Alpha");
  await expect(page.getByText("No matching items")).toBeVisible();
  await search.fill("");
  await expect(nav("All items")).toContainText("1");

  // The Trash view lists it with days remaining, has its own search, and is read-only.
  await nav("Trash").click();
  await expect(nav("Trash")).toContainText("1");
  await expect(search).toHaveAttribute("placeholder", "Search Trash");
  await expect(itemRow(page, "Alpha")).toContainText("30 days left");
  await search.fill("bravo");
  await expect(itemRow(page, "Alpha")).toHaveCount(0);
  await search.fill("alp");
  await itemRow(page, "Alpha").click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);

  // Restore puts it back.
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("The Trash is empty")).toBeVisible();
  await search.fill("");
  await nav("All items").click();
  await expect(itemRow(page, "Alpha")).toBeVisible();

  // Delete both, then Empty Trash Purges them after a confirm that names every device.
  for (const name of ["Alpha", "Bravo"]) {
    await itemRow(page, name).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(itemRow(page, name)).toHaveCount(0);
  }
  await nav("Trash").click();
  await expect(nav("Trash")).toContainText("2");
  await page.getByRole("button", { name: "Empty Trash" }).click();
  await expect(page.getByText("The Trash is empty")).toBeVisible();
  expect(dialogs.at(-1)).toMatch(/all your devices/);
  await nav("All items").click();
  await expect(page.getByText("Your vault is empty.")).toBeVisible();
});
