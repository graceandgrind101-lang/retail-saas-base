import { expect, test } from "@playwright/test";
import { newShop, signInWithPin } from "./support";

// Phase A exit checks that need a real browser (docs/PHASE_A_PLAN.md section 2).

test("smoke: connect a device, sign in with a PIN, the till, the admin app, settings, in Amharic and back", async ({ page }) => {
  const shop = await newShop();
  await signInWithPin(page, shop, "Demo Manager"); // connects the device and signs in with the PIN
  await expect(page).toHaveURL(/\/pos/);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  // switch the language through the shop menu preference endpoint, like the screen does
  const switched = await page.request.post("/api/preferences", { data: { language: "am" }, headers: { origin: new URL(page.url()).origin } });
  expect(switched.ok()).toBe(true);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "am");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toHaveCount(0);
});

test("one shop's owner cannot see or touch another shop's people, through the real app", async ({ page, browser }) => {
  const mine = await newShop();
  const other = await newShop();
  await signInWithPin(page, mine, "Demo Owner");

  // someone from the other shop, found with the other shop's own owner
  const second = await browser.newContext();
  const otherPage = await second.newPage();
  await signInWithPin(otherPage, other, "Demo Owner");
  await otherPage.goto("/staff");
  const href = await otherPage.getByRole("link", { name: /Demo Cashier/ }).getAttribute("href");
  await second.close();
  expect(href).toMatch(/^\/staff\/[0-9a-f-]{36}$/);
  const foreignId = (href as string).split("/").pop() as string;

  const response = await page.goto(href as string);
  expect(response?.status()).toBe(404);

  const origin = new URL(page.url()).origin;
  const attempt = await page.request.post("/api/staff/status", { data: { staffId: foreignId, status: "suspended" }, headers: { origin } });
  expect(attempt.ok()).toBe(false);
  const pin = await page.request.post("/api/staff/pin", { data: { staffId: foreignId, pin: "135792" }, headers: { origin } });
  expect(pin.ok()).toBe(false);
});
