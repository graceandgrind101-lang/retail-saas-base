import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { getDefaultBranch, listDevices } from "@retail/db";
import { pickText } from "@retail/i18n";
import { DevicesView } from "./devices-view";
import { tenantDb } from "@/lib/db";
import { stillAhead } from "@/lib/now";
import { loadShellContext } from "@/lib/shell/context";

export default async function DevicesPage() {
  const ctx = await loadShellContext();
  if (!ctx) redirect("/sign-in");
  if (!ctx.permissions.includes("device:manage")) redirect("/");
  const locale = await getLocale();
  const { devices, branch } = await tenantDb().rls(ctx.session, async (tx) => ({ devices: await listDevices(tx), branch: await getDefaultBranch(tx) }));
  return (
    <DevicesView
      branchId={branch?.id ?? null}
      devices={devices.map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        branch: pickText(d.branchName, locale),
        pairedAt: d.pairedAt.toISOString(),
        pairedBy: d.pairedBy,
        lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
        revoked: d.revokedAt !== null,
        lockedUntil: stillAhead(d.lockedUntil) && d.lockedUntil ? d.lockedUntil.toISOString() : null,
      }))}
    />
  );
}
