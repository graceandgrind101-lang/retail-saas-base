"use client";

import { useState } from "react";
import Link from "next/link";
import { useMessages, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { ALERT_CATEGORIES, isAlertOpen, type AlertCategory, type AlertStatus } from "@retail/core";
import { formatDateTime, resolveCalendar, type CalendarKind, type Messages } from "@retail/i18n";
import { Button, CategoryBadge, Sheet, Tile, useToast } from "@retail/ui";
import { postJson } from "@/lib/client/api";

export interface AlertRowData {
  id: string;
  category: AlertCategory;
  ruleKey: string;
  status: AlertStatus;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

const TONES = ["a", "b", "c", "d", "a", "b"] as const;

function calendarFromDocument(): CalendarKind {
  const match = /(?:^|; )retail_cal=([^;]*)/.exec(typeof document === "undefined" ? "" : document.cookie);
  return resolveCalendar({ user: match?.[1] ? decodeURIComponent(match[1]) : null });
}

export function AlertsView({
  alerts,
  counts,
  canResolve,
  showClosed,
  locale,
  timeZone,
  title,
}: {
  alerts: AlertRowData[];
  counts: Record<AlertCategory, number>;
  canResolve: boolean;
  showClosed: boolean;
  locale: string;
  timeZone: string;
  title: string;
}) {
  const t = useTranslations();
  const messages = useMessages() as unknown as Messages;
  const toast = useToast();
  const router = useRouter();
  const [selected, setSelected] = useState<AlertRowData | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const ruleText = (ruleKey: string) => (t.has(`alerts.rule.${ruleKey}`) ? t(`alerts.rule.${ruleKey}`) : ruleKey);
  const when = (iso: string) => formatDateTime(new Date(iso), { locale, calendar: calendarFromDocument(), timeZone, messages });
  const errorText = (code: string | undefined) => (code && t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.server_error"));

  async function change(alert: AlertRowData, status: "ack" | "resolved" | "dismissed") {
    setBusy(true);
    const result = await postJson("/api/alerts/status", { alertId: alert.id, status, ...(note.trim() ? { note: note.trim() } : {}) });
    setBusy(false);
    if (!result.ok) {
      toast.show({ message: errorText(result.data.error), tone: "bad" });
      return;
    }
    toast.show({ message: t("alertsScreen.saved"), tone: "ok" });
    setSelected(null);
    setNote("");
    router.refresh();
  }

  return (
    <div className="ui-stack">
      <h1>{title}</h1>
      <div className="ui-grid" data-wide="4">
        {ALERT_CATEGORIES.map((category, index) => (
          <Tile key={category} value={String(counts[category])} label={t(`alerts.category.${category}`)} tone={TONES[index] ?? "a"} />
        ))}
      </div>

      {alerts.length === 0 ? (
        <p>{t("alertsScreen.empty")}</p>
      ) : (
        <ul className="alert-list">
          {alerts.map((alert) => (
            <li key={alert.id}>
              <button type="button" className="alert-row" onClick={() => { setSelected(alert); setNote(""); }}>
                <span>
                  <CategoryBadge category={alert.category} label={t(`alerts.category.${alert.category}`)} />{" "}
                  <strong>{ruleText(alert.ruleKey)}</strong>
                </span>
                <small>
                  {t(`alerts.status.${alert.status}`)} · {when(alert.createdAt)}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Link className="ui-link" href={showClosed ? "/alerts" : "/alerts?closed=1"}>{showClosed ? t("alerts.status.new") + " / " + t("alerts.status.ack") : t("alertsScreen.showClosed")}</Link>

      <Sheet open={selected !== null} onClose={() => setSelected(null)} title={t("alertsScreen.detail")} closeLabel={t("common.close")}>
        {selected ? (
          <div className="alert-detail">
            <div>
              <CategoryBadge category={selected.category} label={t(`alerts.category.${selected.category}`)} />
            </div>
            <strong>{ruleText(selected.ruleKey)}</strong>
            <div>
              {t("alertsScreen.when")}: {when(selected.createdAt)}
            </div>
            <div>{t(`alerts.status.${selected.status}`)}</div>
            {selected.note ? (
              <div>
                {t("alertsScreen.note")}: {selected.note}
              </div>
            ) : null}
            {selected.resolvedAt ? (
              <div>
                {t("alertsScreen.closedBy")}: {when(selected.resolvedAt)}
              </div>
            ) : null}
            {canResolve && isAlertOpen(selected.status) ? (
              <>
                <textarea aria-label={t("alertsScreen.note")} placeholder={t("alertsScreen.notePlaceholder")} value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
                {selected.status === "new" ? <Button label={t("alerts.action.ack")} icon="check" variant="secondary" loading={busy} onClick={() => void change(selected, "ack")} /> : null}
                <Button label={t("alerts.action.resolve")} icon="check" loading={busy} onClick={() => void change(selected, "resolved")} />
                <Button label={t("alerts.action.dismiss")} icon="close" variant="secondary" loading={busy} onClick={() => void change(selected, "dismissed")} />
              </>
            ) : null}
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
