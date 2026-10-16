import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_SCRIPT, THEME_STORAGE_KEY, isThemePreference, resolveTheme, setThemePreference } from "./theme-script";

const root = document.documentElement;

interface Media {
  matches: boolean;
  listeners: (() => void)[];
  addEventListener: (type: string, fn: () => void) => void;
}
function stubDevice(dark: boolean, options: { storage?: boolean; media?: boolean } = {}): Media {
  const media: Media = { matches: dark, listeners: [], addEventListener: (_type, fn) => media.listeners.push(fn) };
  if (options.media === false) vi.stubGlobal("matchMedia", undefined);
  else vi.stubGlobal("matchMedia", () => media);
  Object.defineProperty(window, "matchMedia", { configurable: true, value: options.media === false ? undefined : () => media });
  if (options.storage === false) {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
  }
  return media;
}
const runScript = () => new Function(THEME_SCRIPT)();

beforeEach(() => {
  localStorage.clear();
  root.removeAttribute("data-theme");
  root.removeAttribute("data-theme-preference");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("which theme to show", () => {
  it("an explicit choice wins; anything else follows the device", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    for (const junk of [undefined, null, "", "blue", 5, "DARK"]) {
      expect(resolveTheme(junk, true), String(junk)).toBe("dark");
      expect(resolveTheme(junk, false), String(junk)).toBe("light");
    }
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("Dark")).toBe(false);
  });
});

describe("the pre-paint script", () => {
  it("sets the theme at once: the device's preference when nothing is chosen", () => {
    stubDevice(true);
    runScript();
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.getAttribute("data-theme-preference")).toBe("system");
    stubDevice(false);
    runScript();
    expect(root.getAttribute("data-theme")).toBe("light");
  });

  it("a saved choice beats the device", () => {
    stubDevice(true);
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    runScript();
    expect([root.getAttribute("data-theme"), root.getAttribute("data-theme-preference")]).toEqual(["light", "light"]);
    stubDevice(false);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    runScript();
    expect([root.getAttribute("data-theme"), root.getAttribute("data-theme-preference")]).toEqual(["dark", "dark"]);
  });

  it("junk in storage is treated as 'system'", () => {
    stubDevice(true);
    localStorage.setItem(THEME_STORAGE_KEY, "purple");
    runScript();
    expect([root.getAttribute("data-theme"), root.getAttribute("data-theme-preference")]).toEqual(["dark", "system"]);
  });

  it("follows the device live while the choice is 'system', and ignores it otherwise", () => {
    const media = stubDevice(false);
    runScript();
    expect(root.getAttribute("data-theme")).toBe("light");
    media.matches = true;
    media.listeners.forEach((fn) => fn());
    expect(root.getAttribute("data-theme")).toBe("dark");

    localStorage.setItem(THEME_STORAGE_KEY, "light");
    media.listeners.forEach((fn) => fn());
    expect(root.getAttribute("data-theme")).toBe("light");
  });

  it("never throws: blocked storage and a missing matchMedia just mean light", () => {
    stubDevice(true, { storage: false });
    expect(() => runScript()).not.toThrow();
    expect(root.getAttribute("data-theme")).toBe("dark"); // the device still decides
    stubDevice(true, { media: false });
    vi.unstubAllGlobals();
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
    expect(() => runScript()).not.toThrow();
    expect(root.getAttribute("data-theme")).toBe("light");
  });
});

describe("the picker's helper", () => {
  it("remembers the choice and shows it now; 'system' forgets it", () => {
    stubDevice(false);
    runScript();
    setThemePreference("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
    setThemePreference("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(root.getAttribute("data-theme")).toBe("light");
  });

  it("does not throw when storage is blocked", () => {
    stubDevice(false, { storage: false });
    expect(() => setThemePreference("dark")).not.toThrow();
  });
});
