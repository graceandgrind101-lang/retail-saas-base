/**
 * Light or dark, per person (PLAN.md §3). `system` follows the device. The choice is remembered in
 * the browser and applied by a tiny script that runs BEFORE the first paint (put THEME_SCRIPT in
 * <head>), so a dark-mode person never sees a white flash. The same choice later also lives on the
 * staff record (`theme`) so it follows the person to another device.
 */
export const THEME_STORAGE_KEY = "retail_theme";
export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/** What to show: an explicit choice wins; anything else (nothing, junk) follows the device. */
export function resolveTheme(preference: unknown, prefersDark: boolean): "light" | "dark" {
  if (preference === "light" || preference === "dark") return preference;
  return prefersDark ? "dark" : "light";
}

/**
 * The script itself, as text for an inline <script>. It is plain old JavaScript with no
 * dependencies and never throws (a blocked storage or a missing matchMedia just means light),
 * because a failing script in <head> must not break the page. It keeps the choice in
 * `data-theme-preference` and the shown theme in `data-theme`, and follows the device live
 * while the choice is `system`.
 */
export const THEME_SCRIPT = `(function(){
  var root = document.documentElement;
  var media = null;
  try { media = window.matchMedia("(prefers-color-scheme: dark)"); } catch (e) {}
  function stored() {
    try { var v = localStorage.getItem("${THEME_STORAGE_KEY}"); return v === "light" || v === "dark" ? v : "system"; } catch (e) { return "system"; }
  }
  function apply() {
    var preference = stored();
    var dark = preference === "dark" || (preference === "system" && !!media && media.matches);
    root.setAttribute("data-theme-preference", preference);
    root.setAttribute("data-theme", dark ? "dark" : "light");
  }
  apply();
  try { if (media && media.addEventListener) media.addEventListener("change", apply); } catch (e) {}
  window.__applyRetailTheme = apply;
})();`;

/** For a theme picker: remember the choice and show it now. Safe if storage is blocked. */
export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // storage blocked: the choice lasts until the page closes
  }
  const apply = (window as unknown as { __applyRetailTheme?: () => void }).__applyRetailTheme;
  if (apply) apply();
}
