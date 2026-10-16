import { sql } from "drizzle-orm";
import {
  SETTINGS,
  effectiveSettingState,
  isSettingKey,
  parseSettingValue,
  viewSettings,
  type SettingKey,
  type SettingState,
  type SettingView,
} from "@retail/core";
import { PinApprovalRequiredError, SettingLockedError, translateAuthError } from "./errors";
import { consumeStepUp } from "./devices";
import type { RlsTransaction } from "./rls";

/**
 * A shop's settings (Phase A task A14). The registry in core says which settings exist, their
 * types, defaults and launch state; this reads what the shop has chosen and saves new choices.
 * Reading needs nothing special here (server code decides what a screen may show); saving goes
 * through `app.set_setting`, which needs settings:edit, refuses a locked setting, and asks for the
 * person's own PIN approval on a sensitive one.
 */

export class InvalidSettingError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Not a valid value for the setting ${key}.`);
    this.name = "InvalidSettingError";
    this.key = key;
  }
}

/** Every setting a shop may see, with its value (or default), state and whether it asks for a PIN. */
export async function getSettings(tx: RlsTransaction): Promise<SettingView[]> {
  const stored = await tx.execute<{ key: string; value: unknown }>(sql`select key, value from app.tenant_settings`);
  const policies = await tx.execute<{ key: string; tenant_state: SettingState | null; platform_state: SettingState | null }>(
    sql`select key, tenant_state, platform_state from app.my_setting_policies()`,
  );
  return viewSettings({
    stored: Object.fromEntries(stored.map((row) => [row.key, row.value])),
    policies: Object.fromEntries(policies.map((row) => [row.key, { tenant: row.tenant_state, platform: row.platform_state }])),
  });
}

/** One setting's value (the default if the shop has not chosen). */
export async function getSetting(tx: RlsTransaction, key: SettingKey): Promise<unknown> {
  return (await getSettings(tx)).find((view) => view.key === key)?.value ?? SETTINGS[key].default;
}

/**
 * Save a choice. Run with `write: true`.
 *  - an unknown key or a value that does not fit throws `InvalidSettingError` (nothing is written);
 *  - a locked or hidden setting throws `SettingLockedError`;
 *  - a sensitive setting needs `verificationId`, the PIN approval the person got from `requestStepUp`
 *    for the action `settings:edit`; without a good one it throws `PinApprovalRequiredError`.
 */
export async function saveSetting(tx: RlsTransaction, input: { key: string; value: unknown; verificationId?: string }): Promise<void> {
  if (!isSettingKey(input.key)) throw new InvalidSettingError(input.key);
  const parsed = parseSettingValue(input.key, input.value);
  if (!parsed.ok) throw new InvalidSettingError(input.key);
  const def = SETTINGS[input.key];
  const sensitive = "sensitive" in def;

  // Locked and hidden come first: a person is never asked for a PIN (nor an approval used up) for something that cannot be saved.
  const policy = await tx.execute<{ tenant_state: SettingState | null; platform_state: SettingState | null }>(
    sql`select tenant_state, platform_state from app.my_setting_policies() where key = ${input.key}`,
  );
  const state = effectiveSettingState(input.key, { tenant: policy[0]?.tenant_state ?? null, platform: policy[0]?.platform_state ?? null });
  if (state !== "editable") throw new SettingLockedError();

  if (sensitive) {
    if (!input.verificationId) throw new PinApprovalRequiredError();
    await consumeStepUp(tx, { verificationId: input.verificationId, actionKey: "settings:edit" });
  }
  try {
    await tx.execute(sql`select app.set_setting(${input.key}, ${JSON.stringify(parsed.value)}::text::jsonb, ${def.state}, ${sensitive})`);
  } catch (error) {
    const translated = translateAuthError(error);
    if (translated instanceof SettingLockedError || translated instanceof PinApprovalRequiredError) throw translated;
    throw error;
  }
}
