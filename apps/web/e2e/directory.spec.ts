import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { newShop, signInWithPin } from "./support";

// Staff, devices and Activity in a real browser: the owner adds a cashier, connects a device, and
// both show up in Activity.

const scan = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);

test("the owner adds a cashier, connects a device, and sees both in Activity", async ({ page }) => {
  const shop = await newShop();
  await signInWithPin(page, shop, "Demo Owner");

  await page.goto("/staff");
  await expect(page.getByRole("heading", { name: "Staff", level: 1 })).toBeVisible();
  await expect(page.getByText("Demo Owner")).toBeVisible();
  expect(await scan(page)).toEqual([]);

  await page.getByRole("button", { name: "Add a person" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Selam Bekele");
  await page.getByLabel("PIN (optional, 4 to 6 digits)").fill("482915");
  await page.locator("form").getByRole("button", { name: "Add a person" }).click();
  await expect(page.getByRole("heading", { name: "Selam Bekele", level: 1 })).toBeVisible();
  await expect(page.getByText("Has a PIN")).toBeVisible();

  await page.goto("/devices");
  await expect(page.getByRole("heading", { name: "Devices", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Connect a new device" }).click();
  await expect(page.locator(".pair-code")).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  expect(await scan(page)).toEqual([]);
  await page.keyboard.press("Escape");

  await page.goto("/activity");
  await expect(page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
  await expect(page.locator(".timeline")).toContainText("Selam Bekele was added");
  await expect(page.locator(".timeline")).toContainText("A code to connect a device was made");
  expect(await scan(page)).toEqual([]);
});

test("a person can be suspended and reinstated, and it shows on their page", async ({ page }) => {
  const shop = await newShop();
  await signInWithPin(page, shop, "Demo Owner");
  await page.goto("/staff");
  await page.getByRole("link", { name: /Demo Cashier/ }).click();
  await expect(page.getByRole("heading", { name: "Demo Cashier", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Suspend" }).click();
  await expect(page.locator(".directory-meta .directory-tag")).toHaveText("Suspended");
  await page.getByRole("button", { name: "Reinstate" }).click();
  await expect(page.locator(".directory-meta .directory-tag")).toHaveText("Active");
  await expect(page.locator(".timeline")).toContainText("Demo Cashier was suspended");
  await expect(page.locator(".timeline")).toContainText("Demo Cashier was reinstated");
});

test("a cashier cannot open staff, devices or activity", async ({ page }) => {
  const shop = await newShop();
  await signInWithPin(page, shop, "Demo Cashier");
  for (const path of ["/staff", "/devices", "/activity"]) {
    await page.goto(path);
    await expect(page).not.toHaveURL(new RegExp(`${path}$`));
  }
});

test("works on a 360px phone without sideways scrolling", async ({ page }) => {
  const shop = await newShop();
  await page.setViewportSize({ width: 360, height: 740 });
  await signInWithPin(page, shop, "Demo Owner");
  for (const path of ["/staff", "/devices", "/activity"]) {
    await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
