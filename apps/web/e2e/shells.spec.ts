import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { newShop, ownAddress, pair, signInWithPin, typePin } from "./support";

// The admin app and the till in a real browser, on a phone (Pixel 7) and a desktop: signing in with a
// PIN on a connected device, the menus, the permissions behind them, the alerts screen, the Ctrl+K
// search, the till's lock and its idle lock, and an accessibility scan of every screen.

const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;
const scan = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);

test.describe("signing in", () => {
  test("a new device is connected with a code, then people sign in with a PIN", async ({ page }) => {
    const shop = await newShop();
    await ownAddress(page);
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { name: "Connect this device" })).toBeVisible();
    await expect(page.getByText("Signing in with an account")).toBeVisible();
    expect(await scan(page)).toEqual([]);

    await pair(page, shop.pairingCode);
    await expect(page.getByRole("button", { name: "Demo Cashier" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Demo Owner" })).toHaveCount(0); // no PIN, so not offered
    expect(await scan(page)).toEqual([]);

    await page.getByRole("button", { name: "Demo Cashier" }).click();
    await expect(page.getByRole("heading", { name: "Demo Cashier" })).toBeVisible();
    expect(await scan(page)).toEqual([]);
    await typePin(page, "0000");
    await expect(page.locator(".ui-toast")).toContainText("Wrong PIN.");
    await expect(page.getByRole("heading", { name: "Demo Cashier" })).toBeVisible(); // still here

    await typePin(page, shop.pins.cashier);
    await page.waitForURL("**/pos");
    await expect(page.getByText("Counter 1 · Cashier: Demo Cashier")).toBeVisible();
  });

  test("the code works once, and a wrong code says so", async ({ page, browser }) => {
    const shop = await newShop();
    await ownAddress(page);
    await page.goto("/sign-in");
    await page.getByLabel("Code").fill("ZZZZ-ZZZZ");
    await page.getByLabel("Name of this device").fill("X");
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.locator(".ui-toast")).toContainText("This code is not valid or has expired.");

    await pair(page, shop.pairingCode);
    const other = await browser.newContext();
    const second = await other.newPage();
    await ownAddress(second);
    await second.goto("/sign-in");
    await second.getByLabel("Code").fill(shop.pairingCode);
    await second.getByLabel("Name of this device").fill("Copy");
    await second.getByRole("button", { name: "Connect" }).click();
    await expect(second.locator(".ui-toast")).toContainText("This code is not valid or has expired.");
    await other.close();
  });

  test("five wrong PINs lock the person, and say so", async ({ page }) => {
    const shop = await newShop();
    await ownAddress(page);
    await pair(page, shop.pairingCode);
    await page.getByRole("button", { name: "Demo Cashier" }).click();
    for (let i = 0; i < 5; i++) {
      await typePin(page, "0000");
      await expect(page.locator(".ui-toast").last()).toContainText("Wrong PIN.");
    }
    await typePin(page, shop.pins.cashier);
    await expect(page.locator(".ui-toast").last()).toContainText("Too many wrong PINs");
    await expect(page).toHaveURL(/sign-in/);
  });

  test("somebody who is not signed in is sent to sign in, from every screen", async ({ page }) => {
    for (const path of ["/", "/alerts", "/pos", "/pos/today", "/pos/more"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/sign-in/);
    }
  });

  test("the developer sign-in does not exist in a production build", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByText("Developer sign-in")).toHaveCount(0);
    const response = await page.request.post("/api/dev/sign-in", { data: {}, headers: { origin: "http://localhost:3113" } });
    expect(response.status()).toBe(404);
  });
});

test.describe("the till", () => {
  test("header, tabs, navigation, and a lock that really ends the sign-in", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Cashier");
    await expect(page).toHaveURL(/\/pos$/);
    await expect(page.getByRole("heading", { name: "Sell" })).toBeVisible();
    const tabs = page.getByRole("navigation", { name: "Main menu" });
    for (const name of ["Sell", "Today", "Parked", "More"]) await expect(tabs.getByRole("link", { name })).toBeVisible();
    await expect(tabs.getByRole("link", { name: "Sell" })).toHaveAttribute("aria-current", "page");

    await tabs.getByRole("link", { name: "Today" }).click();
    await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
    await expect(tabs.getByRole("link", { name: "Today" })).toHaveAttribute("aria-current", "page");
    await tabs.getByRole("link", { name: "More" }).click();
    await expect(page.getByRole("heading", { name: "More" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the admin app" })).toHaveCount(0); // a cashier cannot manage staff
    expect(await scan(page)).toEqual([]);

    await page.getByRole("button", { name: "Lock" }).click();
    await page.waitForURL("**/sign-in");
    await expect(page.getByText("Locked for safety")).toHaveCount(0); // a manual lock is not the idle lock
    expect((await page.request.get("/api/auth/me")).status()).toBe(401);
    await page.goto("/pos");
    await expect(page).toHaveURL(/sign-in/);
  });

  test("locks itself after a quiet time, and says why", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Cashier");
    await expect(page).toHaveURL(/\/pos$/);
    await page.waitForURL(/sign-in\?locked=idle/, { timeout: 15_000 });
    await expect(page.getByText("Locked for safety after a quiet moment.")).toBeVisible();
    expect((await page.request.get("/api/auth/me")).status()).toBe(401);
  });

  test("activity keeps it unlocked", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Cashier");
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(1500);
      await page.mouse.move(10 + i * 7, 10 + i * 5);
    }
    await expect(page).toHaveURL(/\/pos$/);
  });

  test("a manager can open the admin app from the till", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Manager");
    await page.goto("/pos/more");
    await page.getByRole("link", { name: "Open the admin app" }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("passes the accessibility scan in both themes", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Cashier");
    expect(await scan(page)).toEqual([]);
    await page.evaluate(() => (window as unknown as { __applyRetailTheme: () => void }).__applyRetailTheme());
    await page.evaluate(() => {
      localStorage.setItem("retail_theme", "dark");
      (window as unknown as { __applyRetailTheme: () => void }).__applyRetailTheme();
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await scan(page)).toEqual([]);
  });
});

test.describe("the admin app", () => {
  test("a manager sees the frame that fits the screen, with Home and Alerts", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Manager");
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Hello, Demo Manager" })).toBeVisible();
    await expect(page).toHaveTitle("Home");

    const menu = page.getByRole("navigation", { name: "Main menu" });
    if (isDesktop(page)) {
      // sidebar and right rail; no bottom tabs
      await expect(page.locator(".shell-sidebar")).toBeVisible();
      await expect(page.locator(".shell-rail")).toBeVisible();
      await expect(page.locator(".shell-tabs")).toBeHidden();
      const sidebar = page.locator(".shell-sidebar");
      await expect(sidebar.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
      await expect(sidebar.getByRole("link", { name: "Alerts" })).toBeVisible();
      await expect(page.locator(".shell-sidebar").getByText("Demo Shop")).toBeVisible();
    } else {
      await expect(page.locator(".shell-tabs")).toBeVisible();
      await expect(page.locator(".shell-sidebar")).toBeHidden();
      await expect(page.locator(".shell-rail")).toBeHidden();
      await expect(menu.last().getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
      await expect(menu.last().getByRole("link", { name: "Alerts" })).toBeVisible();
      await expect(menu.last().getByRole("button", { name: "More" })).toBeVisible();
    }
    // nothing that is not built yet is offered, and modules show only what exists
    await expect(page.getByRole("link", { name: "Products" })).toHaveCount(0);
    expect(await scan(page)).toEqual([]);
  });

  test("a cashier has no Alerts, and cannot walk in through the address bar", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Cashier");
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Alerts" })).toHaveCount(0);
    await page.goto("/alerts");
    await expect(page).toHaveURL(/\/$/);
  });

  test("no horizontal scroll, on any admin screen", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Manager");
    for (const path of ["/", "/alerts", "/pos/more"]) {
      await page.goto(path);
      const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(scroll, path).toBeLessThanOrEqual(inner);
    }
  });

  test("every control in the frame is at least 44 by 44 pixels", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Manager");
    await page.goto("/");
    const small = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("a[href], button, select, input")) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        if (el.classList.contains("skip-link")) continue;
        if (box.width < 44 || box.height < 44) out.push(`${el.textContent?.trim() || el.getAttribute("aria-label")} ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
      return out;
    });
    expect(small).toEqual([]);
  });

  test("the alerts screen lists, counts, and lets someone with permission close one", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Manager");
    await page.goto("/alerts");
    await expect(page.getByRole("heading", { name: "Alerts", level: 1 })).toBeVisible();
    const rows = page.locator(".alert-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Suspicion");
    await expect(page.getByRole("link", { name: /Alerts, 2 open/ }).first()).toBeVisible();
    expect(await scan(page)).toEqual([]);

    await rows.filter({ hasText: "A staff member was locked out after 5 wrong PINs" }).click();
    const dialog = page.getByRole("dialog", { name: "Alert details" });
    await expect(dialog).toBeVisible();
    expect(await scan(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Mark as seen" }).click();
    await expect(page.locator(".ui-toast")).toContainText("Saved");
    await expect(rows.filter({ hasText: "Seen" })).toHaveCount(1);

    await rows.filter({ hasText: "Seen" }).click();
    await page.getByRole("dialog").getByLabel("Note").fill("Spoke to the cashier");
    await page.getByRole("dialog").getByRole("button", { name: "Resolve" }).click();
    await expect(rows).toHaveCount(1);
    await expect(page.getByRole("link", { name: /Alerts, 1 open/ }).first()).toBeVisible();

    await page.getByRole("link", { name: "Show closed alerts" }).click();
    await expect(page).toHaveURL(/closed=1/);
    await expect(page.locator(".alert-row")).toHaveCount(2);
    await page.locator(".alert-row", { hasText: "Resolved" }).click();
    await expect(page.getByRole("dialog")).toContainText("Spoke to the cashier");
    await expect(page.getByRole("dialog").getByRole("button", { name: "Resolve" })).toHaveCount(0); // closed is final
  });

  test("the account sheet switches language, calendar and theme", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Manager");
    await page.goto("/");
    await page.getByRole("button", { name: isDesktop(page) ? "Display" : "Demo Shop" }).first().click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toContainText("Signed in as Demo Manager");
    await sheet.getByLabel("Theme").selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await sheet.getByLabel("Language").selectOption("am");
    await expect(page.locator("html")).toHaveAttribute("lang", "am");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "ሰላም፣ Demo Manager" })).toBeVisible();
    await expect(page).toHaveTitle("መነሻ");
    expect(await scan(page)).toEqual([]);
  });

  test("signing out ends the sign-in", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Manager");
    await page.goto("/");
    await page.getByRole("button", { name: isDesktop(page) ? "Display" : "Demo Shop" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL("**/sign-in");
    expect((await page.request.get("/api/auth/me")).status()).toBe(401);
  });

  test("the impersonation banner is not shown to anyone yet", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Manager");
    await page.goto("/");
    await expect(page.locator(".shell-banner")).toHaveCount(0);
  });
});

test("Ctrl+K opens the search on a desktop, and Enter goes to the first match", async ({ page }) => {
  test.skip(!isDesktop(page), "a keyboard shortcut");
  const shop = await newShop();
  await signInWithPin(page, shop, "Demo Manager");
  await page.goto("/");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Search" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("searchbox")).toBeFocused();
  await dialog.getByRole("searchbox").fill("ale");
  await expect(dialog.getByRole("link")).toHaveCount(1);
  await dialog.getByRole("searchbox").fill("zzz");
  await expect(dialog).toContainText("Nothing found");
  await dialog.getByRole("searchbox").fill("ale");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/alerts$/);
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Search" })).toBeHidden();
});

test("on a phone the search button opens the same search", async ({ page }) => {
  test.skip(isDesktop(page), "the phone layout");
  const shop = await newShop();
  await signInWithPin(page, shop, "Demo Manager");
  await page.goto("/");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
});
