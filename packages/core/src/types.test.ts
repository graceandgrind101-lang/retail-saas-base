import { describe, expect, it } from "vitest";
import { RESERVED_TENANT_SLUGS, isValidTenantSlug } from "./types";

describe("isValidTenantSlug", () => {
  it.each(["nati-mobile", "abc", "shop24", "a1b", "x".repeat(40)])("accepts %j", (slug) => {
    expect(isValidTenantSlug(slug)).toBe(true);
  });

  it.each([
    "",
    "ab", // too short
    "x".repeat(41), // too long
    "-shop",
    "shop-",
    "Shop", // uppercase
    "my_shop", // underscore
    "my shop",
    "shop.example", // dot would create a sub-subdomain
    "ሱቅ", // non-ASCII is not a valid hostname label here
  ])("rejects %j", (slug) => {
    expect(isValidTenantSlug(slug)).toBe(false);
  });

  it("rejects every reserved subdomain", () => {
    for (const reserved of RESERVED_TENANT_SLUGS) {
      expect(isValidTenantSlug(reserved)).toBe(false);
    }
  });
});
