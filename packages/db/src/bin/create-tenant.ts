// pnpm tenant:create --slug nati-mobile --name "Nati Mobile" --industry electronics --plan pro
//   --name-am "ናቲ ሞባይል"   shop name in Amharic (optional)
//   --status pilot|trial|active   (default pilot)
//   --legal-name, --tin           optional
//   --modules pos,inventory,...   (default: the starter set for the industry)
//   --owner-email, --owner-name   invite the owner (both required together). The invitation
//                                 token is printed ONCE: copy it now, it is not stored.
//   DATABASE_ADMIN_URL            owner connection (required, from the environment)
import { parseArgs } from "node:util";
import postgres from "postgres";
import { INDUSTRIES, isModuleKey, type Industry, type LocalizedText, type ModuleKey } from "@retail/core";
import { TenantProvisioningError, provisionTenant } from "../tenants";

const { values } = parseArgs({
  options: {
    slug: { type: "string" },
    name: { type: "string" },
    "name-am": { type: "string" },
    industry: { type: "string" },
    plan: { type: "string" },
    status: { type: "string" },
    "legal-name": { type: "string" },
    tin: { type: "string" },
    modules: { type: "string" },
    "owner-email": { type: "string" },
    "owner-name": { type: "string" },
  },
  strict: true,
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) fail("DATABASE_ADMIN_URL: is missing");
if (!values.slug || !values.name || !values.industry || !values.plan) {
  fail('Usage: pnpm tenant:create --slug <address> --name "<shop name>" --industry <industry> --plan <plan>\n  industries: ' + INDUSTRIES.join(", "));
}
if (!(INDUSTRIES as readonly string[]).includes(values.industry)) {
  fail(`--industry must be one of: ${INDUSTRIES.join(", ")}`);
}
const status = values.status ?? "pilot";
if (!["pilot", "trial", "active"].includes(status)) fail("--status must be pilot, trial or active");

let modules: ModuleKey[] | undefined;
if (values.modules !== undefined) {
  const requested = values.modules.split(",").map((m) => m.trim()).filter(Boolean);
  const unknown = requested.filter((m) => !isModuleKey(m));
  if (unknown.length > 0) fail(`unknown module(s): ${unknown.join(", ")}`);
  modules = requested as ModuleKey[];
}

if ((values["owner-email"] === undefined) !== (values["owner-name"] === undefined)) {
  fail("--owner-email and --owner-name must be given together");
}

const displayName: LocalizedText = { en: values.name };
if (values["name-am"]) displayName.am = values["name-am"];

const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
try {
  const result = await provisionTenant(sql, {
    slug: values.slug,
    displayName,
    industry: values.industry as Industry,
    planKey: values.plan,
    status: status as "pilot" | "trial" | "active",
    ...(values["legal-name"] !== undefined ? { legalName: values["legal-name"] } : {}),
    ...(values.tin !== undefined ? { tin: values.tin } : {}),
    ...(modules ? { modules } : {}),
    ...(values["owner-email"] !== undefined && values["owner-name"] !== undefined
      ? { owner: { email: values["owner-email"], displayName: values["owner-name"] } }
      : {}),
  });
  console.log(`created shop "${result.slug}"`);
  console.log(`  tenant id: ${result.tenantId}`);
  console.log(`  default branch: ${result.branchId}`);
  console.log(`  modules: ${result.modules.join(", ")}`);
  if (result.ownerInvite) {
    console.log(`  owner invitation (valid until ${result.ownerInvite.expiresAt.toISOString().slice(0, 10)}):`);
    console.log(`    path:  /invite/${result.ownerInvite.token}`);
    console.log("    The token is shown only now and is not stored. Send it to the owner; if it is lost, create a new invitation.");
  }
} catch (error) {
  if (error instanceof TenantProvisioningError) fail(error.message);
  throw error;
} finally {
  await sql.end();
}
