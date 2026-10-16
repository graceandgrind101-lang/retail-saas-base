import { describe, expect, it } from "vitest";
import { INDUSTRIES, MODULE_KEYS, defaultModulesFor, isModuleKey } from "./modules";

describe("module registry", () => {
  it("has unique, well-formed keys (the database only accepts lowercase letters and underscores)", () => {
    expect(new Set(MODULE_KEYS).size).toBe(MODULE_KEYS.length);
    for (const key of MODULE_KEYS) expect(key).toMatch(/^[a-z][a-z_]*$/);
  });

  it("isModuleKey accepts known keys only", () => {
    expect(isModuleKey("pos")).toBe(true);
    expect(isModuleKey("serials")).toBe(true);
    expect(isModuleKey("POS")).toBe(false);
    expect(isModuleKey("nonsense")).toBe(false);
    expect(isModuleKey("")).toBe(false);
  });
});

describe("defaultModulesFor", () => {
  it("every industry gets the point of sale, stock and payment checks", () => {
    for (const industry of INDUSTRIES) {
      expect(defaultModulesFor(industry)).toEqual(expect.arrayContaining(["pos", "inventory", "payments"]));
    }
  });

  it("only electronics gets serial numbers and warranty", () => {
    expect(defaultModulesFor("electronics")).toContain("serials");
    for (const industry of INDUSTRIES.filter((i) => i !== "electronics")) {
      expect(defaultModulesFor(industry)).not.toContain("serials");
    }
  });

  it("never switches on modules that are not built yet", () => {
    for (const industry of INDUSTRIES) {
      for (const later of ["dube", "storefront", "manufacturing", "transfers"]) {
        expect(defaultModulesFor(industry)).not.toContain(later);
      }
    }
  });

  it("returns only registered modules, without duplicates, and a fresh array each time", () => {
    for (const industry of INDUSTRIES) {
      const modules = defaultModulesFor(industry);
      expect(modules.every(isModuleKey)).toBe(true);
      expect(new Set(modules).size).toBe(modules.length);
    }
    expect(defaultModulesFor("other")).not.toBe(defaultModulesFor("other"));
  });
});
