import type { BuildExtraConfigColumns } from "drizzle-orm";
import {
  pgSchema,
  timestamp,
  unique,
  uuid,
  type PgColumnBuilderBase,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { tenants } from "./platform";

/** All tenant business data lives in `app` and is protected by row-level security. */
export const appSchema = pgSchema("app");

/**
 * Columns every tenant table has (DATA_MODEL §1). `id` has no database default on purpose:
 * ids are UUIDv7 made by the application (`uuidv7()` in @retail/core), on the device for
 * anything created offline, so replaying a write is a no-op.
 */
export const standardColumns = () => ({
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Staff id of the creator; null for system actions. Not a foreign key: staff come later. */
  createdBy: uuid("created_by"),
});

/**
 * Define a tenant table: the standard columns, plus `unique (tenant_id, id)` so other
 * tables can reference it with a composite foreign key `(tenant_id, x_id)` (DATA_MODEL M4:
 * the database itself makes cross-tenant references impossible).
 *
 * Defining the table is not enough. Its migration MUST also call
 * `select private.secure_tenant_table('app.<name>')`, which turns on row-level security,
 * forces it, adds the tenant-isolation policy, sets grants and attaches the updated_at
 * trigger. `pnpm --filter @retail/db check:db-security` (run in CI) fails if that was forgotten.
 */
export function tenantTable<TName extends string, TColumns extends Record<string, PgColumnBuilderBase>>(
  name: TName,
  columns: TColumns,
  extraConfig?: (
    self: BuildExtraConfigColumns<TName, ReturnType<typeof standardColumns> & TColumns, "pg">,
  ) => PgTableExtraConfigValue[],
) {
  return appSchema.table(
    name,
    { ...standardColumns(), ...columns },
    (self) => [
      unique(`${name}_tenant_id_id_unique`).on(self.tenantId, self.id),
      ...(extraConfig ? extraConfig(self) : []),
    ],
  );
}
