import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { newShop, signInWithPin, typePin } from "./support";

// The settings screen in a real browser, on a phone and a desktop.

const scan = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);

const tab = (page: Page, name: string) => page.getByRole("tab", { name });

test.describe("as the owner", () => {
  test("sections are tabs kept in the address, and a section can be opened by its address", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Owner");
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await expect(page).toHaveTitle("Home");
    for (const name of ["Business profile", "Receipt", "Inventory", "Language and calendar", "Payment accounts", "Pricing rules", "Security"]) {
      await expect(tab(page, name)).toBeVisible();
    }
    await expect(tab(page, "Business profile")).toHaveAttribute("aria-selected", "true");

    await tab(page, "Inventory").click();
    await expect(page).toHaveURL(/\/settings\?tab=inventory$/);
    await expect(page.getByLabel("Low-stock level")).toBeVisible();

    await page.goto("/settings?tab=receipt");
    await expect(tab(page, "Receipt")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Receipt footer")).toBeVisible();
    await page.goto("/settings?tab=nonsense");
    await expect(tab(page, "Business profile")).toHaveAttribute("aria-selected", "true");
    expect(await scan(page)).toEqual([]);
  });

  test("an ordinary setting is saved and is still there after a reload", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Owner");
    await page.goto("/settings?tab=inventory");
    await expect(page.getByLabel("Low-stock level")).toHaveValue("5");
    await page.getByLabel("Low-stock level").fill("12");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".ui-toast")).toContainText("Saved");
    await page.reload();
    await expect(page.getByLabel("Low-stock level")).toHaveValue("12");
    // a value that does not fit is refused, with a message
    await page.getByLabel("Low-stock level").fill("-3");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".ui-toast").last()).toContainText("That value is not valid.");
    await page.reload();
    await expect(page.getByLabel("Low-stock level")).toHaveValue("12");
  });

  test("a locked section shows locks and a way to reach support, and cannot be edited", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Owner");
    await page.goto("/settings?tab=payments");
    const rows = page.locator(".setting");
    await expect(rows).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      await expect(rows.nth(i).getByText("Locked")).toBeVisible();
      await expect(rows.nth(i).getByText("Contact support to change this.")).toBeVisible();
      await expect(rows.nth(i).locator("input")).toBeDisabled();
    }
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    expect(await scan(page)).toEqual([]);

    // a mixed section: the fiscal label is locked while the rest is not
    await page.goto("/settings?tab=receipt");
    await expect(page.locator(".setting", { hasText: "Print “not a fiscal receipt”" }).locator("input")).toBeDisabled();
    await expect(page.locator(".setting", { hasText: "Receipt footer" }).locator("input").first()).toBeEnabled();
  });

  test("the search finds settings in every section", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Owner");
    await page.goto("/settings");
    await page.getByRole("searchbox", { name: "Search settings" }).fill("discount");
    await expect(page.locator(".setting")).toHaveCount(1);
    await expect(page.getByText("Pricing rules")).toBeVisible();
    await expect(page.getByText("Largest discount (%)")).toBeVisible();
    await page.getByRole("searchbox", { name: "Search settings" }).fill("zzzz");
    await expect(page.getByText("No settings match.")).toBeVisible();
    await page.getByRole("searchbox", { name: "Search settings" }).fill("");
    await expect(tab(page, "Business profile")).toBeVisible();
  });

  test("a sensitive setting asks for the owner's PIN: a wrong PIN saves nothing, the right one does", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Owner");
    await page.goto("/settings");
    await expect(page.getByText("Asks for your PIN", { exact: true })).toBeVisible();
    await page.getByLabel("Shop phone number").fill("0911000000");
    await page.getByRole("button", { name: "Save" }).click();

    const dialog = page.getByRole("dialog", { name: "Your PIN" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Enter your PIN to save this change.");
    expect(await scan(page)).toEqual([]);
    await typePin(page, "0000");
    await expect(page.locator(".ui-toast").last()).toContainText("Wrong PIN.");
    await page.reload();
    await expect(page.getByLabel("Shop phone number")).toHaveValue("");

    await page.getByLabel("Shop phone number").fill("0911000000");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("dialog", { name: "Your PIN" })).toBeVisible();
    await typePin(page, shop.pins.owner);
    await expect(page.locator(".ui-toast").last()).toContainText("Saved");
    await page.reload();
    await expect(page.getByLabel("Shop phone number")).toHaveValue("0911000000");
  });

  test("closing the PIN prompt saves nothing", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Owner");
    await page.goto("/settings");
    await page.getByLabel("Shop phone number").fill("0911000000");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("dialog", { name: "Your PIN" }).getByRole("button", { name: "Close" }).click();
    await page.reload();
    await expect(page.getByLabel("Shop phone number")).toHaveValue("");
  });

  test("the shop's default language is used by everyone who has not chosen their own", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Owner");
    await page.goto("/settings?tab=locale");
    await page.getByLabel("Default language").selectOption("am");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".ui-toast")).toContainText("Saved");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "am");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("ቅንብሮች");
    expect(await scan(page)).toEqual([]);
  });

  test("passes the accessibility scan in the dark theme too", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Owner");
    await page.goto("/settings?tab=business");
    await page.evaluate(() => {
      localStorage.setItem("retail_theme", "dark");
      (window as unknown as { __applyRetailTheme: () => void }).__applyRetailTheme();
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await scan(page)).toEqual([]);
  });

  test("nothing spills sideways and every control is thumb sized, in every section", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Owner");
    for (const group of ["business", "receipt", "inventory", "locale", "payments", "pricing", "security"]) {
      await page.goto(`/settings?tab=${group}`);
      await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
      const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(scroll, group).toBeLessThanOrEqual(inner);
      const small = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>(".setting input, .setting select, button, [role=tab]")) {
          const box = el.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue;
          if (box.width < 44 || box.height < 44) out.push(`${el.getAttribute("aria-label") || el.textContent?.trim() || el.id} ${Math.round(box.width)}x${Math.round(box.height)}`);
        }
        return out;
      });
      expect(small, group).toEqual([]);
    }
  });
});

test.describe("as other people", () => {
  test("a manager can look at the settings but not change them", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Manager");
    await page.goto("/settings?tab=inventory");
    await expect(page.getByLabel("Low-stock level")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  });

  test("a cashier has no Settings and is sent home from its address", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Cashier");
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/$/);
  });

  test("the menu offers Settings to someone who may see it, under Configuration", async ({ page }) => {
    const shop = await newShop();
    await signInWithPin(page, shop, "Demo Manager");
    await page.goto("/");
    if ((page.viewportSize()?.width ?? 0) >= 1024) {
      await expect(page.locator(".shell-sidebar").getByText("Configuration")).toBeVisible();
      await page.locator(".shell-sidebar").getByRole("link", { name: "Settings" }).click();
    } else {
      await page.getByRole("button", { name: "More" }).click();
      await page.getByRole("dialog").getByRole("link", { name: "Settings" }).click();
    }
    await expect(page).toHaveURL(/\/settings/);
  });
});
