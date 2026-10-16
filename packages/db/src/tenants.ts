import type { Sql } from "postgres";
import {
  INDUSTRIES,
  INVITE_VALID_DAYS,
  SYSTEM_ROLES,
  SYSTEM_ROLE_KEYS,
  defaultModulesFor,
  generateInviteToken,
  hashInviteToken,
  isModuleKey,
  isValidTenantSlug,
  uuidv7,
  type Industry,
  type LocalizedText,
  type ModuleKey,
  type SystemRoleKey,
} from "@retail/core";

/**
 * Creating a shop (Phase A task A6). Platform work: it runs as the owner through `db.admin`, in
 * ONE transaction, so a shop either exists completely or not at all:
 *   the shop, its modules, its default branch, the five system roles, optionally the owner's
 *   invitation, and an audit entry saying who made it.
 * What each role may DO (its permissions) is added by task A9.
 */

/** Stored as data in the shop's own language(s); not an interface string. */
const DEFAULT_BRANCH_NAME: LocalizedText = { en: "Main branch", am: "ዋና ቅርንጫፍ" };

export type ProvisioningProblem =
  | "invalid_slug"
  | "slug_taken"
  | "invalid_name"
  | "invalid_industry"
  | "invalid_plan"
  | "invalid_modules"
  | "invalid_owner";

export class TenantProvisioningError extends Error {
  readonly problem: ProvisioningProblem;

  constructor(problem: ProvisioningProblem, message: string) {
    super(message);
    this.name = "TenantProvisioningError";
    this.problem = problem;
  }
}

export interface ProvisionTenantInput {
  /** The shop's subdomain: 3-40 lowercase letters, digits and hyphens, not a name we use ourselves. */
  slug: string;
  displayName: LocalizedText;
  industry: Industry;
  /** e.g. "pro" or "business" (PLAN.md D12). */
  planKey: string;
  /** Defaults to "pilot". */
  status?: "pilot" | "trial" | "active";
  legalName?: string;
  tin?: string;
  /** Defaults to the starter set for the industry (core: defaultModulesFor). */
  modules?: ModuleKey[];
  /**
   * Invite the owner. They follow the invitation with a login account whose VERIFIED email
   * matches this address, and become the shop's Owner. Without it the shop has no staff yet.
   */
  owner?: { email: string; displayName: string };
}

export interface ProvisionedTenant {
  tenantId: string;
  branchId: string;
  slug: string;
  modules: ModuleKey[];
  /** The system roles created for the shop, by key. */
  roleIds: Record<SystemRoleKey, string>;
  /**
   * The owner's invitation. `token` is the secret in the link and is returned ONLY here, once:
   * the database keeps just its hash. Hand it over (or lose it and create a new invitation).
   */
  ownerInvite?: { staffId: string; token: string; expiresAt: Date };
}

const EMAIL_SHAPE = /^[^\s@\u0000-\u001f]+@[^\s@\u0000-\u001f]+\.[^\s@\u0000-\u001f]+$/;

function validate(input: ProvisionTenantInput): ModuleKey[] {
  if (!isValidTenantSlug(input.slug)) {
    throw new TenantProvisioningError(
      "invalid_slug",
      `"${input.slug}" is not a valid shop address: use 3-40 lowercase letters, digits and hyphens, and not a reserved name`,
    );
  }
  const names = Object.values(input.displayName).filter((v): v is string => typeof v === "string" && v.trim() !== "");
  if (names.length === 0) {
    throw new TenantProvisioningError("invalid_name", "the shop needs a name in at least one language");
  }
  if (!(INDUSTRIES as readonly string[]).includes(input.industry)) {
    throw new TenantProvisioningError("invalid_industry", `unknown industry "${input.industry}"`);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(input.planKey)) {
    throw new TenantProvisioningError("invalid_plan", `"${input.planKey}" is not a valid plan key`);
  }
  const modules = input.modules ?? defaultModulesFor(input.industry);
  const unknown = modules.filter((m) => !isModuleKey(m));
  if (unknown.length > 0 || new Set(modules).size !== modules.length) {
    throw new TenantProvisioningError("invalid_modules", `invalid module list: ${modules.join(", ")}`);
  }
  if (input.owner) {
    const email = input.owner.email.trim();
    if (email.length > 254 || !EMAIL_SHAPE.test(email)) {
      throw new TenantProvisioningError("invalid_owner", `"${input.owner.email}" is not a valid email address`);
    }
    if (input.owner.displayName.trim() === "") {
      throw new TenantProvisioningError("invalid_owner", "the owner needs a name");
    }
  }
  return modules;
}

export async function provisionTenant(sql: Sql, input: ProvisionTenantInput): Promise<ProvisionedTenant> {
  const modules = validate(input);
  const tenantId = uuidv7();
  const branchId = uuidv7();
  const roleIds = Object.fromEntries(SYSTEM_ROLE_KEYS.map((key) => [key, uuidv7()])) as Record<SystemRoleKey, string>;

  let ownerInvite: ProvisionedTenant["ownerInvite"];
  let inviteTokenHash = "";
  if (input.owner) {
    const token = generateInviteToken();
    inviteTokenHash = await hashInviteToken(token);
    ownerInvite = {
      staffId: uuidv7(),
      token,
      expiresAt: new Date(Date.now() + INVITE_VALID_DAYS * 86_400_000),
    };
  }

  try {
    await sql.begin(async (tx) => {
      await tx`
        insert into platform.tenants (id, slug, display_name, legal_name, tin, industry, plan_key, status)
        values (${tenantId}, ${input.slug}, ${tx.json(input.displayName as never)}, ${input.legalName ?? null},
                ${input.tin ?? null}, ${input.industry}, ${input.planKey}, ${input.status ?? "pilot"})`;

      for (const moduleKey of modules) {
        await tx`insert into platform.tenant_modules (tenant_id, module_key) values (${tenantId}, ${moduleKey})`;
      }

      await tx`
        insert into app.branches (id, tenant_id, name, is_default)
        values (${branchId}, ${tenantId}, ${tx.json(DEFAULT_BRANCH_NAME as never)}, true)`;

      for (const key of SYSTEM_ROLE_KEYS) {
        await tx`
          insert into app.roles (id, tenant_id, key, name, is_system, template_key)
          values (${roleIds[key]}, ${tenantId}, ${key}, ${tx.json(SYSTEM_ROLES[key].name as never)}, true, ${key})`;
      }

      if (input.owner && ownerInvite) {
        // The invitation: only the token's hash is stored. Contact details are redacted in the
        // audit log by the trigger on app.staff.
        await tx`
          insert into app.staff (id, tenant_id, display_name, role_id, status, invite_email, invite_token_hash, invite_expires_at)
          values (${ownerInvite.staffId}, ${tenantId}, ${input.owner.displayName.trim()}, ${roleIds.owner}, 'invited',
                  ${input.owner.email.trim().toLowerCase()}, ${inviteTokenHash}, ${ownerInvite.expiresAt})`;
      }

      await tx`
        select audit.record_event_for(
          ${tenantId}::uuid, 'tenant.created',
          ${tx.json({
            slug: input.slug,
            industry: input.industry,
            plan: input.planKey,
            modules,
            ownerInvited: input.owner !== undefined,
          } as never)})`;
    });
  } catch (error) {
    const e = error as { code?: string; constraint_name?: string };
    if (e.code === "23505" && e.constraint_name === "tenants_slug_unique") {
      throw new TenantProvisioningError("slug_taken", `the address "${input.slug}" is already taken`);
    }
    throw error;
  }

  return { tenantId, branchId, slug: input.slug, modules, roleIds, ...(ownerInvite ? { ownerInvite } : {}) };
}
