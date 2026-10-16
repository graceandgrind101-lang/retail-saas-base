import { sql } from "drizzle-orm";
import { boolean, check, jsonb, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { LocalizedText } from "@retail/core";
import { tenantTable } from "./tenant-table";

/**
 * A place a shop sells from (DATA_MODEL §3.2). Every shop has exactly one default branch,
 * created with the shop. Staff, devices, shifts, stock and sales are all per branch.
 */
export const branches = tenantTable(
  "branches",
  {
    name: jsonb("name").$type<LocalizedText>().notNull(),
    address: text("address"),
    phone: text("phone"),
    isDefault: boolean("is_default").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    // At most one default branch per shop (the script that creates a shop makes it).
    uniqueIndex("branches_one_default_per_tenant").on(t.tenantId).where(sql`${t.isDefault}`),
    check("branches_name_not_empty", sql`jsonb_typeof(${t.name}) = 'object' AND ${t.name} <> '{}'::jsonb`),
    // The default branch can be renamed but never archived, so a shop always has somewhere to sell.
    check("branches_default_not_archived", sql`NOT (${t.isDefault} AND ${t.archivedAt} IS NOT NULL)`),
  ],
);

export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;
