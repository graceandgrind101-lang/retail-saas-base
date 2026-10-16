import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ALERT_CATEGORIES } from "@retail/core";
import { Card, CardRow, Tile } from "@retail/ui";
import { loadShellContext } from "@/lib/shell/context";

const TONES = ["a", "b", "c", "d", "a", "b"] as const;

export default async function HomePage() {
  const ctx = await loadShellContext();
  const t = await getTranslations();
  if (!ctx) return null; // the layout has already sent this person to sign in
  const counts = ctx.openAlerts;
  const total = counts ? Object.values(counts).reduce((sum, n) => sum + n, 0) : 0;

  return (
    <div className="ui-stack">
      <h1>{t("homeScreen.welcome", { name: ctx.staff.name })}</h1>
      {counts ? (
        <>
          <div className="ui-grid" data-wide="4">
            {ALERT_CATEGORIES.filter((category) => counts[category] > 0 || category === "fraud" || category === "suspicion").map((category) => (
              <Tile key={category} value={String(counts[category])} label={t(`alerts.category.${category}`)} tone={TONES[ALERT_CATEGORIES.indexOf(category)] ?? "a"} />
            ))}
          </div>
          <Card title={t("homeScreen.alertsTitle")} footer={<Link href="/alerts">{t("homeScreen.seeAlerts")}</Link>}>
            {total === 0 ? <CardRow label={t("homeScreen.nothingOpen")} /> : <CardRow count={String(total)} label={t("alerts.open", { count: total })} />}
          </Card>
        </>
      ) : null}
    </div>
  );
}
