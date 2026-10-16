import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { listAlerts } from "@retail/db";
import { AlertsView } from "./alerts-view";
import { tenantDb } from "@/lib/db";
import { loadShellContext } from "@/lib/shell/context";

export default async function AlertsPage({ searchParams }: { searchParams: Promise<{ closed?: string }> }) {
  const ctx = await loadShellContext();
  if (!ctx) redirect("/sign-in");
  if (!ctx.permissions.includes("alert:view") || !ctx.openAlerts) redirect("/");
  const showClosed = (await searchParams).closed === "1";
  const rows = await tenantDb().rls(ctx.session, (tx) =>
    listAlerts(tx, { statuses: showClosed ? ["new", "ack", "resolved", "dismissed"] : ["new", "ack"], limit: 100 }),
  );
  const t = await getTranslations("alerts");
  return (
    <AlertsView
      counts={ctx.openAlerts}
      canResolve={ctx.permissions.includes("alert:resolve")}
      showClosed={showClosed}
      title={t("title")}
      alerts={rows.map((a) => ({
        id: a.id,
        category: a.category,
        ruleKey: a.ruleKey,
        status: a.status,
        note: a.resolutionNote,
        createdAt: a.createdAt.toISOString(),
        resolvedAt: a.resolvedAt?.toISOString() ?? null,
      }))}
    />
  );
}
