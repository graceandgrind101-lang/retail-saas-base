import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { listActivity } from "@retail/db";
import { RecordTimeline } from "@/components/timeline";
import { tenantDb } from "@/lib/db";
import { loadShellContext } from "@/lib/shell/context";

const PAGE = 50;

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const ctx = await loadShellContext();
  if (!ctx) redirect("/sign-in");
  if (!ctx.permissions.includes("audit:view")) redirect("/");
  const before = Number((await searchParams).before);
  const rows = await tenantDb().rls(ctx.session, (tx) => listActivity(tx, { limit: PAGE, ...(Number.isSafeInteger(before) && before > 0 ? { beforeSeq: before } : {}) }));
  const t = await getTranslations("activity");
  const last = rows.at(-1);
  return (
    <div className="ui-stack">
      <h1>{t("title")}</h1>
      <RecordTimeline
        lines={rows.map((a) => ({ seq: a.seq, occurredAt: a.occurredAt.toISOString(), eventKey: a.eventKey, tableName: a.tableName, actorKind: a.actorKind, actorName: a.actorName, subjectName: a.subjectName, before: a.before, after: a.after }))}
      />
      {rows.length === PAGE && last ? (
        <Link className="ui-link" href={`/activity?before=${last.seq}`}>
          {t("older")}
        </Link>
      ) : null}
    </div>
  );
}
