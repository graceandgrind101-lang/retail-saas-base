import type { Sql } from "postgres";
import { DEV_DEMO_OWNER_ACCOUNT_ID, generatePairingCode, formatPairingCode, hashPin, uuidv7 } from "@retail/core";
import { hashPairingCode } from "./devices";
import { provisionTenant } from "./tenants";

/**
 * A demo shop for trying the app on your own computer (`pnpm dev:seed`). NOT for production:
 * it creates people with PINs everyone can read in this file. Platform work: runs as the owner
 * login. Safe to run again: it reuses the demo shop and makes a fresh pairing code each time.
 *
 * The shop: an electronics shop with its owner (who signs in through the developer sign-in), a
 * manager and a cashier (who sign in with a PIN on a connected device), and two sample alerts.
 */
export const DEMO_SLUG = "demo";
export const DEMO_PINS = { owner: "2580", manager: "4829", cashier: "7391" } as const;

export interface DemoSeed {
  tenantId: string;
  ownerAccountId: string;
  /** Type this on a new device to connect it to the demo shop (valid 10 minutes, once). */
  pairingCode: string;
  pins: typeof DEMO_PINS;
  created: boolean;
}

/** `options.slug` makes another demo-style shop (the browser tests make one per test); the default is the one the developer uses. */
export async function seedDemoShop(sql: Sql, peppers: { devicePepper: string; pinPepper: string }, options: { slug?: string } = {}): Promise<DemoSeed> {
  const slug = options.slug ?? DEMO_SLUG;
  const existing = await sql<{ id: string }[]>`select id from platform.tenants where slug = ${slug}`;
  let tenantId = existing[0]?.id;
  let created = false;
  let branchId: string;
  let roleIds: Record<string, string>;

  if (!tenantId) {
    const shop = await provisionTenant(sql, {
      slug,
      displayName: { en: "Demo Shop", am: "የናሙና ሱቅ" },
      industry: "electronics",
      planKey: "pro",
    });
    tenantId = shop.tenantId;
    branchId = shop.branchId;
    roleIds = shop.roleIds;
    created = true;

    const person = async (name: string, role: "owner" | "manager" | "cashier", options: { account?: string; pin?: string } = {}) => {
      const id = uuidv7();
      const pinHash = options.pin ? await hashPin(options.pin, peppers.pinPepper) : null;
      await sql`
        insert into app.staff (id, tenant_id, display_name, role_id, status, auth_user_id, pin_hash, pin_set_at)
        values (${id}, ${tenantId as string}, ${name}, ${roleIds[role] as string}, 'active', ${options.account ?? null}, ${pinHash},
                ${pinHash ? new Date().toISOString() : null}::timestamptz)`;
      return id;
    };
    await person("Demo Owner", "owner", { account: DEV_DEMO_OWNER_ACCOUNT_ID, pin: DEMO_PINS.owner });
    await person("Demo Manager", "manager", { pin: DEMO_PINS.manager });
    await person("Demo Cashier", "cashier", { pin: DEMO_PINS.cashier });

    // two sample alerts so the alerts screen has something to show
    const [cashier] = await sql<{ id: string }[]>`select id from app.staff where tenant_id = ${tenantId} and display_name = 'Demo Cashier'`;
    await sql`select private.raise_alert(${tenantId}::uuid, ${branchId}::uuid, 'pin.staff_locked', 'suspicion', 3, 'staff', ${cashier?.id as string}::uuid,
              ${JSON.stringify({ staff_id: cashier?.id })}::text::jsonb)`;
    await sql`select private.raise_alert(${tenantId}::uuid, ${branchId}::uuid, 'pin.device_locked', 'suspicion', 4, null, null, '{}'::jsonb)`;
  } else {
    const [branch] = await sql<{ id: string }[]>`select id from app.branches where tenant_id = ${tenantId} and is_default`;
    branchId = branch?.id as string;
  }

  const [owner] = await sql<{ id: string; pin_hash: string | null }[]>`select id, pin_hash from app.staff where tenant_id = ${tenantId} and auth_user_id = ${DEV_DEMO_OWNER_ACCOUNT_ID}`;
  if (!owner) throw new Error("the demo shop exists but has no demo owner; run `pnpm db:reset` and seed again");
  if (!owner.pin_hash) {
    // a demo shop made before the owner had a PIN: give the owner the demo PIN (needed to save a sensitive setting)
    await sql`update app.staff set pin_hash = ${await hashPin(DEMO_PINS.owner, peppers.pinPepper)}, pin_set_at = now() where tenant_id = ${tenantId} and id = ${owner.id}`;
  }

  const code = generatePairingCode();
  await sql`
    insert into app.device_pairing_codes (id, tenant_id, created_by, branch_id, code_hash, expires_at)
    values (${uuidv7()}, ${tenantId}, ${owner.id}, ${branchId}, ${await hashPairingCode(peppers.devicePepper, code)}, now() + interval '10 minutes')`;

  return { tenantId, ownerAccountId: DEV_DEMO_OWNER_ACCOUNT_ID, pairingCode: formatPairingCode(code), pins: DEMO_PINS, created };
}
