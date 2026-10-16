import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SETTING_KEYS, SETTINGS } from "@retail/core";
import { requestStepUp, setStaffPin } from "../src/devices";
import { PinApprovalRequiredError, SettingLockedError, StepUpInvalidError } from "../src/errors";
import { InvalidSettingError, getSetting, getSettings, saveSetting } from "../src/settings";
import { setOverride } from "../src/permissions";
import { createTenantDb, type RlsContext, type TenantDb } from "../src/rls";
import { acceptInvite, startSession } from "../src/sign-in";
import { isShopReadOnlyError } from "../src/tenant-info";
import { provisionTenant } from "../src/tenants";
import { PG, adminSql, appUrl, expectPgError, newId } from "./helpers";

const admin: Sql = adminSql(4);
let db: TenantDb;
const PIN_PEPPER = "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b";

beforeAll(() => {
  db = createTenantDb(appUrl(), { max: 10 });
});
afterAll(async () => {
  await db.close();
  await admin.end();
});

const suffix = () => randomBytes(4).toString("hex");

interface Shop {
  tenantId: string;
  roleIds: Record<string, string>;
  owner: RlsContext;
  ownerId: string;
}

async function makeShop(prefix: string): Promise<Shop> {
  const email = `owner-${suffix()}@example.com`;
  const shop = await provisionTenant(admin, { slug: `${prefix}-${suffix()}`, displayName: { en: `Shop ${prefix}` }, industry: "electronics", planKey: "pro", owner: { email, displayName: "Owner Person" } });
  const acct = { authUserId: newId(), email };
  await db.identity(acct, (tx) => acceptInvite(tx, shop.ownerInvite?.token ?? ""));
  const session = await db.identity(acct, (tx) => startSession(tx, { tenantId: shop.tenantId, method: "password" }));
  return { tenantId: shop.tenantId, roleIds: shop.roleIds, ownerId: session.staffId, owner: { tenantId: shop.tenantId, staffId: session.staffId, sessionId: session.sessionId } };
}

async function person(shop: Shop, roleKey: "owner" | "manager" | "cashier") {
  const staffId = newId();
  const sessionId = newId();
  await admin`insert into app.staff (id, tenant_id, display_name, role_id, status) values (${staffId}, ${shop.tenantId}, ${`${roleKey} ${suffix()}`}, ${shop.roleIds[roleKey] as string}, 'active')`;
  await admin`insert into app.staff_sessions (id, tenant_id, staff_id, method, expires_at) values (${sessionId}, ${shop.tenantId}, ${staffId}, 'password', now() + interval '1 day')`;
  return { staffId, ctx: { tenantId: shop.tenantId, staffId, sessionId } as RlsContext };
}

const write = <T>(ctx: RlsContext, fn: Parameters<TenantDb["rls"]>[1]) => db.rls(ctx, fn as never, { write: true }) as Promise<T>;
const save = (ctx: RlsContext, key: string, value: unknown, verificationId?: string) =>
  write<void>(ctx, (tx) => saveSetting(tx, { key, value, ...(verificationId ? { verificationId } : {}) }));
const settings = (ctx: RlsContext) => db.rls(ctx, (tx) => getSettings(tx));
const view = async (ctx: RlsContext, key: string) => (await settings(ctx)).find((v) => v.key === key);
const stored = async (shop: Shop) => admin`select key, value, updated_by from app.tenant_settings where tenant_id = ${shop.tenantId} order by key`;

/** The owner types their own PIN for settings:edit and gets a one-time approval. */
async function approval(shop: Shop, who: { staffId: string; ctx: RlsContext }, pin = "4829") {
  await write(who.ctx, (tx) => setStaffPin(tx, { staffId: who.staffId, pin, pinPepper: PIN_PEPPER, iterations: 1000 }));
  const result = await write<Awaited<ReturnType<typeof requestStepUp>>>(who.ctx, (tx) => requestStepUp(tx, { approverId: who.staffId, pin, actionKey: "settings:edit", pinPepper: PIN_PEPPER }));
  if (!result.ok) throw new Error(`step-up failed: ${result.reason}`);
  return result.verificationId;
}
const ownerAsPerson = (shop: Shop) => ({ staffId: shop.ownerId, ctx: shop.owner });

describe("saving a setting", () => {
  it("an owner saves an editable setting; it shows with its value and as the shop's own choice", async () => {
    const shop = await makeShop("save");
    expect(await view(shop.owner, "inventory.low_stock_threshold")).toMatchObject({ value: 5, customised: false, state: "editable" });
    await save(shop.owner, "inventory.low_stock_threshold", 12);
    expect(await view(shop.owner, "inventory.low_stock_threshold")).toMatchObject({ value: 12, customised: true });
    await save(shop.owner, "inventory.low_stock_threshold", 7);
    expect(await view(shop.owner, "inventory.low_stock_threshold")).toMatchObject({ value: 7 });
    const rows = await stored(shop);
    expect(rows).toHaveLength(1); // replaced, not added
    expect(rows[0]).toMatchObject({ key: "inventory.low_stock_threshold", value: 7, updated_by: shop.ownerId });
  });

  it("stores each kind of value as it was given", async () => {
    const shop = await makeShop("kinds");
    await save(shop.owner, "receipt.footer", { en: "Thank you", am: "አመሰግናለሁ" });
    await save(shop.owner, "receipt.show_cashier", false);
    await save(shop.owner, "locale.default_calendar", "ethiopian");
    await save(shop.owner, "locale.default_language", "am");
    expect(await view(shop.owner, "receipt.footer")).toMatchObject({ value: { en: "Thank you", am: "አመሰግናለሁ" } });
    expect(await view(shop.owner, "receipt.show_cashier")).toMatchObject({ value: false });
    expect(await view(shop.owner, "locale.default_calendar")).toMatchObject({ value: "ethiopian" });
    expect(await view(shop.owner, "locale.default_language")).toMatchObject({ value: "am" });
    expect(await db.rls(shop.owner, (tx) => getSetting(tx, "locale.default_language"))).toBe("am");
    expect(await db.rls(shop.owner, (tx) => getSetting(tx, "inventory.expiry_warning_days"))).toBe(30);
  });

  it("an empty language inside a localized value is dropped, not stored", async () => {
    const shop = await makeShop("drop");
    await save(shop.owner, "receipt.footer", { en: "Thank you", am: "" });
    expect(await view(shop.owner, "receipt.footer")).toMatchObject({ value: { en: "Thank you" } });
  });

  it("a value that does not fit, or an unknown setting, is refused and nothing is written", async () => {
    const shop = await makeShop("invalid");
    const bad: [string, unknown][] = [
      ["inventory.low_stock_threshold", -1],
      ["inventory.low_stock_threshold", 1.5],
      ["inventory.low_stock_threshold", "5"],
      ["inventory.low_stock_threshold", 10_001],
      ["receipt.show_cashier", "yes"],
      ["receipt.footer", "text"],
      ["receipt.footer", { en: "x".repeat(201) }],
      ["locale.default_calendar", "julian"],
      ["locale.default_language", "English"],
      ["nope.nope", 1],
      ["", 1],
      ["constructor", 1],
    ];
    for (const [key, value] of bad) await expect(save(shop.owner, key, value), `${key} = ${JSON.stringify(value)}`).rejects.toBeInstanceOf(InvalidSettingError);
    expect(await stored(shop)).toHaveLength(0);
  });

  it("a stored value that no longer fits is ignored in favour of the default", async () => {
    const shop = await makeShop("stale");
    await admin`insert into app.tenant_settings (id, tenant_id, key, value) values (${newId()}, ${shop.tenantId}, 'inventory.low_stock_threshold', '"lots"'::jsonb)`;
    expect(await view(shop.owner, "inventory.low_stock_threshold")).toMatchObject({ value: 5, customised: false });
  });

  it("every save is in the audit log with who made it, and the old and new value", async () => {
    const shop = await makeShop("audit");
    await save(shop.owner, "inventory.low_stock_threshold", 9);
    await save(shop.owner, "inventory.low_stock_threshold", 11);
    const entries = await admin`select event_key, actor_id, before_data, after_data from audit.log where tenant_id = ${shop.tenantId} and table_name = 'app.tenant_settings' order by seq`;
    expect(entries.map((e) => e.event_key)).toEqual(["row.insert", "row.update"]);
    expect(entries.every((e) => e.actor_id === shop.ownerId)).toBe(true);
    expect(entries[0]?.after_data).toMatchObject({ key: "inventory.low_stock_threshold", value: 9 });
    expect(entries[1]?.before_data).toMatchObject({ value: 9 });
    expect(entries[1]?.after_data).toMatchObject({ value: 11 });
  });

  it("is refused in a paused shop (read-only)", async () => {
    const shop = await makeShop("paused");
    await admin`update platform.tenants set status = 'paused' where id = ${shop.tenantId}`;
    let caught: unknown;
    try {
      await save(shop.owner, "inventory.low_stock_threshold", 9);
    } catch (error) {
      caught = error;
    }
    expect(isShopReadOnlyError(caught)).toBe(true);
  });
});

describe("who may save", () => {
  it("needs settings:edit: a manager and a cashier may not, an owner with a deny may not", async () => {
    const shop = await makeShop("perm");
    const manager = await person(shop, "manager");
    const cashier = await person(shop, "cashier");
    const second = await person(shop, "owner");
    await expectPgError(save(manager.ctx, "inventory.low_stock_threshold", 9), PG.permissionDenied);
    await expectPgError(save(cashier.ctx, "inventory.low_stock_threshold", 9), PG.permissionDenied);
    await save(second.ctx, "inventory.low_stock_threshold", 9);
    await write(shop.owner, (tx) => setOverride(tx, { staffId: second.staffId, key: "settings:edit", effect: "deny", reason: "test" }));
    await expectPgError(save(second.ctx, "inventory.low_stock_threshold", 10), PG.permissionDenied);
    expect(await view(shop.owner, "inventory.low_stock_threshold")).toMatchObject({ value: 9 });
  });

  it("a manager may read the settings (settings:view) but a direct write is refused for everyone", async () => {
    const shop = await makeShop("direct");
    const manager = await person(shop, "manager");
    expect((await settings(manager.ctx)).length).toBe(SETTING_KEYS.length);
    const refuse = (statement: ReturnType<typeof sql>) => expectPgError(write(shop.owner, (tx) => tx.execute(statement)), PG.permissionDenied);
    await save(shop.owner, "inventory.low_stock_threshold", 9);
    await refuse(sql`insert into app.tenant_settings (id, tenant_id, key, value) values (${newId()}, ${shop.tenantId}, 'a.b', '1'::jsonb)`);
    await refuse(sql`update app.tenant_settings set value = '99'::jsonb where tenant_id = ${shop.tenantId}`);
    await refuse(sql`delete from app.tenant_settings where tenant_id = ${shop.tenantId}`);
    expect(await view(shop.owner, "inventory.low_stock_threshold")).toMatchObject({ value: 9 });
  });
});

describe("locked settings cannot be saved, however the request is made", () => {
  it("locked at launch by the registry: the fiscal label, payment accounts, pricing and security", async () => {
    const shop = await makeShop("launch");
    for (const [key, value] of [
      ["receipt.not_fiscal_label", false],
      ["payments.telebirr_number", "0911000000"],
      ["payments.cbe_account", "1000123456789"],
      ["pricing.max_discount_percent", 90],
      ["security.pos_idle_lock_seconds", 0],
    ] as const) {
      await expect(save(shop.owner, key, value), key).rejects.toBeInstanceOf(SettingLockedError);
    }
    expect(await stored(shop)).toHaveLength(0);
  });

  it("locked even for someone who also holds a PIN approval (a locked sensitive setting is not unlocked by a PIN)", async () => {
    const shop = await makeShop("lockedpin");
    const verification = await approval(shop, ownerAsPerson(shop));
    await expect(save(shop.owner, "payments.telebirr_number", "0911000000", verification)).rejects.toBeInstanceOf(SettingLockedError);
    expect(await stored(shop)).toHaveLength(0);
  });

  it("the shop's own policy row can lock an editable setting; another shop's policy does not", async () => {
    const shop = await makeShop("policy");
    const other = await makeShop("policy-other");
    await admin`insert into platform.setting_policies (id, tenant_id, key, state) values (${newId()}, ${other.tenantId}, 'inventory.low_stock_threshold', 'locked')`;
    await save(shop.owner, "inventory.low_stock_threshold", 9); // the other shop's lock is not ours
    await admin`insert into platform.setting_policies (id, tenant_id, key, state) values (${newId()}, ${shop.tenantId}, 'inventory.low_stock_threshold', 'locked')`;
    await expect(save(shop.owner, "inventory.low_stock_threshold", 10)).rejects.toBeInstanceOf(SettingLockedError);
    expect(await view(shop.owner, "inventory.low_stock_threshold")).toMatchObject({ value: 9, state: "locked" });
    await expect(save(other.owner, "inventory.low_stock_threshold", 10)).rejects.toBeInstanceOf(SettingLockedError);
  });

  it("a hidden setting cannot be saved and is not shown", async () => {
    const shop = await makeShop("hidden");
    await admin`insert into platform.setting_policies (id, tenant_id, key, state) values (${newId()}, ${shop.tenantId}, 'receipt.footer', 'hidden')`;
    await expect(save(shop.owner, "receipt.footer", { en: "x" })).rejects.toBeInstanceOf(SettingLockedError);
    expect(await view(shop.owner, "receipt.footer")).toBeUndefined();
    expect((await settings(shop.owner)).length).toBe(SETTING_KEYS.length - 1);
  });

  it("a platform-wide policy locks it for every shop, and a shop's own 'editable' policy beats it", async () => {
    const shop = await makeShop("platform");
    await admin`insert into platform.setting_policies (id, tenant_id, key, state) values (${newId()}, null, 'inventory.expiry_warning_days', 'locked')`;
    try {
      await expect(save(shop.owner, "inventory.expiry_warning_days", 45)).rejects.toBeInstanceOf(SettingLockedError);
      await admin`insert into platform.setting_policies (id, tenant_id, key, state) values (${newId()}, ${shop.tenantId}, 'inventory.expiry_warning_days', 'editable')`;
      await save(shop.owner, "inventory.expiry_warning_days", 45);
      expect(await view(shop.owner, "inventory.expiry_warning_days")).toMatchObject({ value: 45, state: "editable" });
    } finally {
      await admin`delete from platform.setting_policies where tenant_id is null and key = 'inventory.expiry_warning_days'`;
    }
  });

  it("a platform policy can unlock a setting that is locked at launch (the console's way of opening one for one shop)", async () => {
    const shop = await makeShop("unlock");
    await admin`insert into platform.setting_policies (id, tenant_id, key, state) values (${newId()}, ${shop.tenantId}, 'pricing.max_discount_percent', 'editable')`;
    await save(shop.owner, "pricing.max_discount_percent", 15);
    expect(await view(shop.owner, "pricing.max_discount_percent")).toMatchObject({ value: 15, state: "editable" });
  });

  it("the database function itself refuses on the state it is handed, so a hand-made call cannot slip through", async () => {
    const shop = await makeShop("hand");
    const call = (state: string) => write(shop.owner, (tx) => tx.execute(sql`select app.set_setting('inventory.low_stock_threshold', '9'::jsonb, ${state}, false)`));
    await expectPgError(call("locked"), "RT010");
    await expectPgError(call("hidden"), "RT010");
    await expectPgError(call("editable-ish"), PG.checkViolation);
    await call("editable");
    expect(await stored(shop)).toHaveLength(1);
  });

  it("the database function itself honours a platform-wide lock and a shop's own override of it, when called directly", async () => {
    const shop = await makeShop("directpolicy");
    const call = () => write(shop.owner, (tx) => tx.execute(sql`select app.set_setting('inventory.expiry_warning_days', '45'::jsonb, 'editable', false)`));
    await admin`insert into platform.setting_policies (id, tenant_id, key, state) values (${newId()}, null, 'inventory.expiry_warning_days', 'locked')`;
    try {
      await expectPgError(call(), "RT010");
      await admin`insert into platform.setting_policies (id, tenant_id, key, state) values (${newId()}, ${shop.tenantId}, 'inventory.expiry_warning_days', 'editable')`;
      await call();
      expect(await stored(shop)).toHaveLength(1);
    } finally {
      await admin`delete from platform.setting_policies where tenant_id is null and key = 'inventory.expiry_warning_days'`;
    }
  });

  it("the database refuses a malformed key and a JSON null even when called directly", async () => {
    const shop = await makeShop("malformed");
    const call = (key: string, value: string) => write(shop.owner, (tx) => tx.execute(sql`select app.set_setting(${key}, ${value}::text::jsonb, 'editable', false)`));
    await expectPgError(call("Bad Key", "1"), PG.checkViolation);
    await expectPgError(call("nodot", "1"), PG.checkViolation);
    await expectPgError(call("a.b", "null"), PG.checkViolation);
    await call("a.b", "1");
  });

  it("the policies a shop can see are only its own and the platform's", async () => {
    const shop = await makeShop("seepolicies");
    const other = await makeShop("seepolicies-other");
    await admin`insert into platform.setting_policies (id, tenant_id, key, state) values (${newId()}, ${shop.tenantId}, 'receipt.footer', 'locked'), (${newId()}, ${other.tenantId}, 'business.address', 'hidden')`;
    const rows = await db.rls(shop.owner, (tx) => tx.execute(sql`select key, tenant_state, platform_state from app.my_setting_policies()`));
    expect(rows.map((r) => r.key)).toContain("receipt.footer");
    expect(rows.map((r) => r.key)).not.toContain("business.address");
    expect(rows.find((r) => r.key === "receipt.footer")).toMatchObject({ tenant_state: "locked", platform_state: null });
  });

  it("shops do not see each other's choices", async () => {
    const a = await makeShop("iso-a");
    const b = await makeShop("iso-b");
    await save(a.owner, "inventory.low_stock_threshold", 9);
    expect(await view(b.owner, "inventory.low_stock_threshold")).toMatchObject({ value: 5, customised: false });
    await save(b.owner, "inventory.low_stock_threshold", 20);
    expect(await view(a.owner, "inventory.low_stock_threshold")).toMatchObject({ value: 9 });
  });
});

describe("a sensitive setting asks for the person's own PIN", () => {
  it("without an approval it is refused; with the owner's own PIN it is saved, and the audit log names the approval", async () => {
    const shop = await makeShop("sensitive");
    expect(SETTINGS["business.phone"].state).toBe("editable");
    await expect(save(shop.owner, "business.phone", "0911000000")).rejects.toBeInstanceOf(PinApprovalRequiredError);
    expect(await stored(shop)).toHaveLength(0);

    const verification = await approval(shop, ownerAsPerson(shop));
    await save(shop.owner, "business.phone", "0911000000", verification);
    expect(await view(shop.owner, "business.phone")).toMatchObject({ value: "0911000000", customised: true });
    const [entry] = await admin`select pin_verification_id, actor_id from audit.log where tenant_id = ${shop.tenantId} and table_name = 'app.tenant_settings' order by seq desc limit 1`;
    expect(entry?.pin_verification_id).toBe(verification);
    expect(entry?.actor_id).toBe(shop.ownerId);
  });

  it("an approval works once", async () => {
    const shop = await makeShop("once");
    const verification = await approval(shop, ownerAsPerson(shop));
    await save(shop.owner, "business.phone", "0911000000", verification);
    await expect(save(shop.owner, "business.phone", "0922000000", verification)).rejects.toBeInstanceOf(StepUpInvalidError);
    expect(await view(shop.owner, "business.phone")).toMatchObject({ value: "0911000000" });
  });

  it("an approval for another action, or typed by someone else, does not count (checked by the database itself)", async () => {
    const shop = await makeShop("wrongpin");
    const second = await person(shop, "owner");
    const direct = (verificationId: string) =>
      write(shop.owner, async (tx) => {
        // spend the approval by hand, then call the function directly with the sensitive flag
        await tx.execute(sql`select app.consume_step_up(${verificationId}::uuid, ${"settings:edit"}, null)`);
        await tx.execute(sql`select app.set_setting('business.phone', '"0911000000"'::jsonb, 'editable', true)`);
      });

    // the second owner types THEIR PIN to approve the first owner's change: not "the same person"
    await write(second.ctx, (tx) => setStaffPin(tx, { staffId: second.staffId, pin: "7391", pinPepper: PIN_PEPPER, iterations: 1000 }));
    const theirs = await write<Awaited<ReturnType<typeof requestStepUp>>>(shop.owner, (tx) => requestStepUp(tx, { approverId: second.staffId, pin: "7391", actionKey: "settings:edit", pinPepper: PIN_PEPPER }));
    if (!theirs.ok) throw new Error("expected an approval");
    await expectPgError(direct(theirs.verificationId), "RT011");

    // an approval for a different action
    await write(shop.owner, (tx) => setStaffPin(tx, { staffId: shop.ownerId, pin: "4829", pinPepper: PIN_PEPPER, iterations: 1000 }));
    const other = await write<Awaited<ReturnType<typeof requestStepUp>>>(shop.owner, (tx) => requestStepUp(tx, { approverId: shop.ownerId, pin: "4829", actionKey: "sale:below_floor", pinPepper: PIN_PEPPER }));
    if (!other.ok) throw new Error("expected an approval");
    await expectPgError(
      write(shop.owner, async (tx) => {
        await tx.execute(sql`select app.consume_step_up(${other.verificationId}::uuid, ${"sale:below_floor"}, null)`);
        await tx.execute(sql`select app.set_setting('business.phone', '"0911000000"'::jsonb, 'editable', true)`);
      }),
      "RT011",
    );
    expect(await stored(shop)).toHaveLength(0);
  });

  it("the function itself requires that the person who typed the PIN is the one who asked, even if the approval is slipped into the request", async () => {
    const shop = await makeShop("slipped");
    const cashier = await person(shop, "cashier");
    await write(shop.owner, (tx) => setStaffPin(tx, { staffId: shop.ownerId, pin: "4829", pinPepper: PIN_PEPPER, iterations: 1000 }));
    // the OWNER types their PIN on the CASHIER's session: an approval whose approver is the owner and whose asker is the cashier
    const given = await write<Awaited<ReturnType<typeof requestStepUp>>>(cashier.ctx, (tx) => requestStepUp(tx, { approverId: shop.ownerId, pin: "4829", actionKey: "settings:edit", pinPepper: PIN_PEPPER }));
    if (!given.ok) throw new Error("expected an approval");
    const tryAsOwner = () =>
      admin.begin(async (tx) => {
        await tx`set local role authenticated`;
        await tx`select set_config('app.tenant_id', ${shop.tenantId}, true), set_config('app.staff_id', ${shop.ownerId}, true), set_config('app.pin_verification_id', ${given.verificationId}, true)`;
        await tx`select app.set_setting('business.phone', '"0911000000"'::jsonb, 'editable', true)`;
      });
    await expectPgError(tryAsOwner(), "RT011");
    expect(await stored(shop)).toHaveLength(0);
  });

  it("a wrong PIN gives no approval, so nothing is saved", async () => {
    const shop = await makeShop("badpin");
    await write(shop.owner, (tx) => setStaffPin(tx, { staffId: shop.ownerId, pin: "4829", pinPepper: PIN_PEPPER, iterations: 1000 }));
    const result = await write<Awaited<ReturnType<typeof requestStepUp>>>(shop.owner, (tx) => requestStepUp(tx, { approverId: shop.ownerId, pin: "0000", actionKey: "settings:edit", pinPepper: PIN_PEPPER }));
    expect(result).toEqual({ ok: false, reason: "wrong_pin" });
    expect(await stored(shop)).toHaveLength(0);
  });

  it("an approval that was not asked for by this session cannot be used by another person's session", async () => {
    const shop = await makeShop("thief");
    const second = await person(shop, "owner");
    const verification = await approval(shop, ownerAsPerson(shop));
    await expect(save(second.ctx, "business.phone", "0911000000", verification)).rejects.toBeInstanceOf(StepUpInvalidError);
  });

  it("an ordinary setting does not ask for a PIN, and an approval given needlessly is simply not used", async () => {
    const shop = await makeShop("nopin");
    await save(shop.owner, "inventory.low_stock_threshold", 9);
    const verification = await approval(shop, ownerAsPerson(shop));
    await save(shop.owner, "inventory.low_stock_threshold", 10, verification);
    expect(await view(shop.owner, "inventory.low_stock_threshold")).toMatchObject({ value: 10 });
  });
});
