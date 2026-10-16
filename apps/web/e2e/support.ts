import { randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { createAdminDb, seedDemoShop, type DemoSeed } from "@retail/db/admin";

// The server's peppers (the same values playwright.config.ts gives it), so the codes made here work in it.
const PEPPERS = { devicePepper: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j", pinPepper: "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b" };

export interface TestShop extends DemoSeed {
  slug: string;
}

/** A brand-new shop (owner, manager, cashier, two open alerts) and a fresh pairing code, just for one test. */
export async function newShop(existingSlug?: string): Promise<TestShop> {
  const admin = createAdminDb(process.env.E2E_ADMIN_URL as string, { max: 1 });
  try {
    const slug = existingSlug ?? `e2e-${randomBytes(5).toString("hex")}`;
    return { ...(await seedDemoShop(admin.sql, PEPPERS, { slug })), slug };
  } finally {
    await admin.close();
  }
}

/** The browser's own address as far as the server can tell, so the pairing limit (per address) is not shared between tests. */
export async function ownAddress(page: Page): Promise<void> {
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  await page.context().setExtraHTTPHeaders({ "cf-connecting-ip": ip });
}

export async function pair(page: Page, code: string, deviceName = "Counter 1"): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Code").fill(code);
  await page.getByLabel("Name of this device").fill(deviceName);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("heading", { name: "Who are you?" })).toBeVisible();
}

export async function typePin(page: Page, pin: string): Promise<void> {
  const pad = page.locator(".ui-pinpad");
  for (const digit of pin) await pad.getByRole("button", { name: digit, exact: true }).click();
  await pad.getByRole("button", { name: "Confirm" }).click();
}

/** Connect a new device to the shop, pick the person and sign in with their PIN. Lands on the till or the admin home. */
export async function signInWithPin(page: Page, shop: TestShop, who: "Demo Manager" | "Demo Cashier"): Promise<void> {
  await ownAddress(page);
  await pair(page, shop.pairingCode);
  await page.getByRole("button", { name: who }).click();
  await typePin(page, who === "Demo Manager" ? shop.pins.manager : shop.pins.cashier);
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
}
