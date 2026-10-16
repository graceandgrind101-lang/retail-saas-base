import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The home page in a real browser: English and Gregorian by default; the pickers switch the
// language and calendar, and the choice survives a reload. At phone and desktop widths.

test("English and Gregorian by default, nothing spills sideways, no accessibility problems", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page).toHaveTitle("Home");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home");
  await expect(page.getByText(/^Today is [A-Z][a-z]{2} \d{1,2}, \d{4}$/)).toBeVisible();
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(scroll).toBeLessThanOrEqual(inner);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});

test("the pickers switch language and calendar, and the choice is remembered", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Language").selectOption("am");
  await expect(page.locator("html")).toHaveAttribute("lang", "am");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("መነሻ");
  await expect(page).toHaveTitle("መነሻ");

  await page.getByLabel("የቀን መቁጠሪያ").selectOption("ethiopian");
  await expect(page.getByText(/^ዛሬ .+ \d{1,2}, \d{4} ነው$/)).toBeVisible();
  await expect(page.getByText(/(መስከረም|ጥቅምት|ኅዳር|ታኅሣሥ|ጥር|የካቲት|መጋቢት|ሚያዝያ|ግንቦት|ሰኔ|ሐምሌ|ነሐሴ|ጳጉሜን) \d{1,2}, \d{4}/)).toBeVisible();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "am");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("መነሻ");

  await page.getByLabel("ቋንቋ").selectOption("en");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home");
  await expect(page.getByText(/^Today is (Meskerem|Tikimt|Hidar|Tahsas|Tir|Yekatit|Megabit|Miazia|Ginbot|Sene|Hamle|Nehase|Pagume) \d{1,2}, \d{4}$/)).toBeVisible();
});
