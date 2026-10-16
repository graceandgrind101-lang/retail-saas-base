/**
 * Text a shop enters in one or more languages, e.g. `{ en: "Main branch", am: "ዋና ቅርንጫፍ" }`
 * (DATA_MODEL §1). At least one non-empty value is required; display falls back to another
 * language when the wanted one is missing. UI strings themselves are not stored like this:
 * they live in the message files (docs/SCREENS.md §0.1).
 */
export type LocalizedText = Partial<Record<string, string>>;

/**
 * Subdomains we use ourselves (PLAN.md D2/D3). A shop may not take one as its slug.
 * Mirrored by a CHECK constraint on platform.tenants (packages/db), which is the real guard.
 */
export const RESERVED_TENANT_SLUGS = [
  "app",
  "console",
  "www",
  "api",
  "admin",
  "static",
  "assets",
  "mail",
  "bot",
  "verifier",
  "status",
  "help",
  "docs",
] as const;

/** 3-40 chars: lowercase letters, digits and hyphens; starts and ends with a letter or digit. */
export const TENANT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export function isValidTenantSlug(slug: string): boolean {
  return TENANT_SLUG_PATTERN.test(slug) && !(RESERVED_TENANT_SLUGS as readonly string[]).includes(slug);
}
