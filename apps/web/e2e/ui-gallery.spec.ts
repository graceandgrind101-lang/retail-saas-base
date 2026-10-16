import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// The component gallery in a real browser, on a phone (Pixel 7) and on a desktop: nothing spills
// sideways, every control is big enough for a thumb, the controls work with real input, and an
// accessibility scan (which also measures contrast in the browser) finds nothing in either theme.

const gallery = async (page: Page) => {
  await page.goto("/ui");
  await expect(page.getByTestId("gallery")).toBeVisible();
};

test("nothing spills sideways", async ({ page }) => {
  await gallery(page);
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(scroll).toBeLessThanOrEqual(inner);
});

test("every control is at least 44 by 44 pixels", async ({ page }) => {
  await gallery(page);
  const small = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("button, select, [role=tab]")) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.width < 44 || box.height < 44) out.push(`${el.textContent?.trim() || el.getAttribute("aria-label")} ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    return out;
  });
  expect(small).toEqual([]);
});

test("the amount keypad takes real taps", async ({ page }) => {
  await gallery(page);
  const keypad = page.locator(".ui-keypad").first();
  for (const key of ["1", "2", ".", "5", "0", "9"]) await keypad.getByRole("button", { name: key, exact: true }).click();
  await expect(page.getByTestId("amount")).toHaveText("12.50");
  await keypad.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByTestId("amount")).toHaveText("12.5");
});

test("the PIN pad hands over the PIN once and shows only dots", async ({ page }) => {
  await gallery(page);
  const pad = page.locator(".ui-pinpad");
  for (const key of ["4", "8", "2", "9"]) await pad.getByRole("button", { name: key, exact: true }).click();
  await expect(pad.getByRole("img", { name: "4 digits entered" })).toBeVisible();
  await expect(pad.locator(".ui-pin-dots")).toHaveText("");
  await pad.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByTestId("submitted")).toHaveText("PIN received (4 digits)");
  await expect(pad.getByRole("img", { name: "0 digits entered" })).toBeVisible();
});

test("hold to confirm needs a real hold", async ({ page }) => {
  await gallery(page);
  const hold = page.getByRole("button", { name: "Hold to pay" });
  await hold.scrollIntoViewIfNeeded(); // the mouse works in screen coordinates
  const box = (await hold.boundingBox()) as { x: number; y: number; width: number; height: number };
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.waitForTimeout(700);
  await expect(page.getByTestId("confirmed")).toHaveText("0"); // a short press does nothing

  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await expect(page.getByRole("button", { name: "Keep holding" })).toBeVisible();
  await page.waitForTimeout(1100);
  await page.mouse.up();
  await expect(page.getByTestId("confirmed")).toHaveText("1");
});

test("the panel opens, traps focus, and closes with Escape", async ({ page }) => {
  await gallery(page);
  await page.getByRole("button", { name: "Open panel" }).click();
  const dialog = page.getByRole("dialog", { name: "Product" });
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox()) as { x: number; width: number; height: number };
  const viewport = page.viewportSize() as { width: number; height: number };
  expect(box.width).toBeLessThanOrEqual(viewport.width);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Open panel" })).toBeFocused();
});

test("a message appears and can be dismissed", async ({ page }) => {
  await gallery(page);
  await page.getByRole("button", { name: "Show a message" }).click();
  const region = page.locator(".ui-toast-region");
  await expect(region).toContainText("Saved");
  await expect(region).toHaveAttribute("aria-live", "polite");
  await region.getByRole("button", { name: "Dismiss" }).click();
  await expect(region).not.toContainText("Saved");
});

test("tabs work with the keyboard", async ({ page }) => {
  await gallery(page);
  await page.getByRole("tab", { name: "Low stock" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Discounted" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("Discounted view");
});

for (const theme of ["light", "dark"] as const) {
  test(`the ${theme} theme has no accessibility problems`, async ({ page }) => {
    await gallery(page);
    await page.getByRole("button", { name: theme === "dark" ? "Dark" : "Light", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });
}

test("dark mode changes the page, and the choice survives a reload with no light flash", async ({ page }) => {
  await gallery(page);
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(dark).not.toBe(light);
  // the script runs before the first paint: check the very first frame after a reload
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      (window as unknown as { __firstTheme: string | null }).__firstTheme = document.documentElement.getAttribute("data-theme");
    });
  });
  await page.reload();
  expect(await page.evaluate(() => (window as unknown as { __firstTheme: string | null }).__firstTheme)).toBe("dark");
});
