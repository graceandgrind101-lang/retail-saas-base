import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { listRoles, listStaff } from "@retail/db";
import { pickText } from "@retail/i18n";
import { StaffList } from "./staff-list";
import { tenantDb } from "@/lib/db";
import { stillAhead } from "@/lib/now";
import { loadShellContext } from "@/lib/shell/context";

export default async function StaffPage() {
  const ctx = await loadShellContext();
  if (!ctx) redirect("/sign-in");
  if (!ctx.permissions.includes("staff:view")) redirect("/");
  const locale = await getLocale();
  const { staff, roles } = await tenantDb().rls(ctx.session, async (tx) => ({ staff: await listStaff(tx), roles: await listRoles(tx) }));
  return (
    <StaffList
      selfId={ctx.staff.staffId}
      canManage={ctx.permissions.includes("staff:manage")}
      canGiveOwner={ctx.staff.roleKey === "owner"}
      roles={roles.map((r) => ({ id: r.id, key: r.key, label: pickText(r.name, locale) }))}
      staff={staff.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        roleKey: s.roleKey,
        hasPin: s.hasPin,
        lockedOut: stillAhead(s.pinLockedUntil),
      }))}
    />
  );
}
