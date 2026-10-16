import { notFound, redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { isUuid } from "@retail/core";
import { getPermissionsOf, getStaffMember, listActivity, listOverrides, listRoles } from "@retail/db";
import { pickText } from "@retail/i18n";
import { StaffDetail } from "./staff-detail";
import { tenantDb } from "@/lib/db";
import { stillAhead } from "@/lib/now";
import { loadShellContext } from "@/lib/shell/context";

export default async function StaffDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await loadShellContext();
  if (!ctx) redirect("/sign-in");
  if (!ctx.permissions.includes("staff:view")) redirect("/");
  if (!isUuid(id)) notFound();
  const locale = await getLocale();
  const canSeeActivity = ctx.permissions.includes("audit:view");
  const loaded = await tenantDb().rls(ctx.session, async (tx) => {
    const member = await getStaffMember(tx, id);
    if (!member) return null;
    return {
      member,
      overrides: await listOverrides(tx, id),
      permissions: [...(await getPermissionsOf(tx, id))].sort(),
      roles: await listRoles(tx),
      activity: canSeeActivity ? await listActivity(tx, { about: id, limit: 30 }) : [],
    };
  });
  if (!loaded) notFound();
  const { member } = loaded;
  return (
    <StaffDetail
      member={{ id: member.id, name: member.name, phone: member.phone, status: member.status, roleId: member.roleId, roleKey: member.roleKey, hasPin: member.hasPin, lockedOut: stillAhead(member.pinLockedUntil), createdAt: member.createdAt.toISOString() }}
      isSelf={member.id === ctx.staff.staffId}
      canManage={ctx.permissions.includes("staff:manage")}
      canGiveOwner={ctx.staff.roleKey === "owner"}
      permissions={loaded.permissions}
      overrides={loaded.overrides}
      roles={loaded.roles.map((r) => ({ id: r.id, key: r.key, label: pickText(r.name, locale) }))}
      activity={loaded.activity.map((a) => ({ seq: a.seq, occurredAt: a.occurredAt.toISOString(), eventKey: a.eventKey, tableName: a.tableName, actorKind: a.actorKind, actorName: a.actorName, subjectName: a.subjectName, before: a.before, after: a.after }))}
    />
  );
}
