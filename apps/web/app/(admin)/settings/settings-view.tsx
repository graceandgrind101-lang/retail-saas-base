"use client";

import { useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { SETTINGS, settingHelpPath, settingLabelPath, type SettingGroup, type SettingKey, type SettingView } from "@retail/core";
import { LOCALES } from "@retail/i18n";
import { Button, Icon, PinPad, Sheet, Tabs, useToast } from "@retail/ui";
import { postJson } from "@/lib/client/api";

type Draft = unknown;

/** The text a person typed or picked, turned into the value the setting stores (null if it cannot be one). */
function toValue(key: SettingKey, draft: Draft): unknown {
  const def = SETTINGS[key];
  if (def.kind === "integer") {
    if (typeof draft === "number") return draft;
    const text = typeof draft === "string" ? draft.trim() : "";
    return /^-?\d+$/.test(text) ? Number(text) : null;
  }
  if (def.kind === "text" && typeof draft === "string") return draft.trim();
  if (def.kind === "localized" && typeof draft === "object" && draft !== null) {
    return Object.fromEntries(Object.entries(draft as Record<string, string>).map(([code, text]) => [code, text.trim()]).filter(([, text]) => text !== ""));
  }
  return draft;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function SettingsView({ views, groups, current, canEdit, staffId }: { views: SettingView[]; groups: SettingGroup[]; current: SettingGroup; canEdit: boolean; staffId: string }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [pinRequest, setPinRequest] = useState<((pin: string | null) => void) | null>(null);

  const errorText = (code: string | undefined) => (code && t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.server_error"));
  const draftOf = (view: SettingView): Draft => (Object.prototype.hasOwnProperty.call(drafts, view.key) ? drafts[view.key] : view.value);
  const changed = (view: SettingView) => Object.prototype.hasOwnProperty.call(drafts, view.key) && !same(toValue(view.key, drafts[view.key]), view.value);
  const editable = (view: SettingView) => canEdit && view.state === "editable";

  const askPin = () => new Promise<string | null>((resolve) => setPinRequest(() => resolve));
  const answerPin = (pin: string | null) => {
    pinRequest?.(pin);
    setPinRequest(null);
  };

  /** Save one setting; true if it went through. A sensitive one first asks for the person's own PIN. */
  async function saveOne(view: SettingView): Promise<boolean> {
    const value = toValue(view.key, draftOf(view));
    if (value === null) {
      toast.show({ message: errorText("invalid_value"), tone: "bad" });
      return false;
    }
    let verificationId: string | undefined;
    if (view.sensitive) {
      const pin = await askPin();
      if (pin === null) return false;
      const approval = await postJson<{ verificationId?: string }>("/api/step-up", { approverId: staffId, pin, actionKey: "settings:edit" });
      if (!approval.ok || !approval.data.verificationId) {
        toast.show({ message: errorText(approval.data.error), tone: "bad" });
        return false;
      }
      verificationId = approval.data.verificationId;
    }
    const result = await postJson("/api/settings", { key: view.key, value, ...(verificationId ? { verificationId } : {}) });
    if (!result.ok) {
      toast.show({ message: errorText(result.data.error), tone: "bad" });
      return false;
    }
    return true;
  }

  async function saveGroup(group: SettingGroup) {
    const todo = views.filter((view) => view.group === group && editable(view) && changed(view));
    if (todo.length === 0) {
      toast.show({ message: t("settingsScreen.noChanges"), tone: "info" });
      return;
    }
    setBusy(group);
    let all = true;
    for (const view of todo) {
      if (await saveOne(view)) {
        setDrafts((current) => {
          const next = { ...current };
          delete next[view.key];
          return next;
        });
      } else {
        all = false;
      }
    }
    setBusy(null);
    if (all) toast.show({ message: t("settingsScreen.saved"), tone: "ok" });
    router.refresh();
  }

  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () => (needle === "" ? [] : views.filter((view) => `${t(settingLabelPath(view.key))} ${t(settingHelpPath(view.key))}`.toLowerCase().includes(needle))),
    [needle, views, t],
  );

  function field(view: SettingView) {
    const def = SETTINGS[view.key];
    const draft = draftOf(view);
    const disabled = !editable(view);
    const id = `${searchId}-${view.key}`;
    const set = (value: Draft) => setDrafts((current) => ({ ...current, [view.key]: value }));
    switch (def.kind) {
      case "boolean":
        return <input id={id} type="checkbox" checked={draft === true} disabled={disabled} onChange={(event) => set(event.target.checked)} />;
      case "integer":
        return <input id={id} type="number" inputMode="numeric" min={def.min} max={def.max} step={1} value={draft === null || draft === undefined ? "" : String(draft)} disabled={disabled} onChange={(event) => set(event.target.value)} />;
      case "enum":
        return (
          <select id={id} value={String(draft)} disabled={disabled} onChange={(event) => set(event.target.value)}>
            {def.options.map((option) => (
              <option key={option} value={option}>
                {t.has(`calendar.${option}`) ? t(`calendar.${option}`) : option}
              </option>
            ))}
          </select>
        );
      case "language":
        return (
          <select id={id} value={String(draft)} disabled={disabled} onChange={(event) => set(event.target.value)}>
            {LOCALES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        );
      case "localized": {
        const texts = (typeof draft === "object" && draft !== null ? draft : {}) as Record<string, string>;
        return (
          <div className="setting-localized">
            {LOCALES.map((l) => (
              <label key={l.code}>
                <span>{l.name}</span>
                <input type="text" lang={l.code} value={texts[l.code] ?? ""} maxLength={def.max} disabled={disabled} onChange={(event) => set({ ...texts, [l.code]: event.target.value })} />
              </label>
            ))}
          </div>
        );
      }
      default:
        return <input id={id} type="text" value={typeof draft === "string" ? draft : ""} maxLength={def.kind === "text" ? def.max : undefined} disabled={disabled} onChange={(event) => set(event.target.value)} />;
    }
  }

  function row(view: SettingView) {
    const def = SETTINGS[view.key];
    const id = `${searchId}-${view.key}`;
    return (
      <div className="setting" key={view.key} data-state={view.state}>
        <div className="setting-head">
          {def.kind === "localized" ? <span className="setting-label">{t(settingLabelPath(view.key))}</span> : <label className="setting-label" htmlFor={id}>{t(settingLabelPath(view.key))}</label>}
          {view.state === "locked" ? (
            <span className="setting-badge">
              <Icon name="lock" size={16} />
              {t("settingsScreen.locked")}
            </span>
          ) : view.sensitive ? (
            <span className="setting-note">{t("settingsScreen.needsPin")}</span>
          ) : null}
        </div>
        <p className="setting-help">{t(settingHelpPath(view.key))}</p>
        {field(view)}
        {view.state === "locked" ? <p className="setting-support">{t("settingsScreen.contactSupport")}</p> : null}
      </div>
    );
  }

  const panel = (group: SettingGroup) => (
    <div className="ui-stack">
      {views.filter((view) => view.group === group).map(row)}
      {canEdit && views.some((view) => view.group === group && view.state === "editable") ? (
        <Button label={t("settingsScreen.save")} icon="check" size="lg" loading={busy === group} onClick={() => void saveGroup(group)} />
      ) : null}
    </div>
  );

  return (
    <div className="ui-stack">
      <h1>{t("settingsScreen.title")}</h1>
      <label className="settings-search">
        <span className="ui-sr-only">{t("settingsScreen.search")}</span>
        <input type="search" value={query} placeholder={t("settingsScreen.searchPlaceholder")} aria-label={t("settingsScreen.search")} onChange={(event) => setQuery(event.target.value)} />
      </label>

      {needle !== "" ? (
        matches.length === 0 ? (
          <p>{t("settingsScreen.noMatch")}</p>
        ) : (
          <div className="ui-stack">
            {matches.map((view) => (
              <div key={view.key} className="ui-stack">
                <span className="setting-group">{t(`settings.groups.${view.group}`)}</span>
                {row(view)}
              </div>
            ))}
            {canEdit && matches.some((view) => editable(view)) ? <Button label={t("settingsScreen.save")} icon="check" size="lg" loading={busy !== null} onClick={() => void saveMatches()} /> : null}
          </div>
        )
      ) : (
        <Tabs
          ariaLabel={t("settingsScreen.title")}
          value={current}
          onChange={(group) => router.replace(`/settings?tab=${group}`)}
          tabs={groups.map((group) => ({ id: group, label: t(`settings.groups.${group}`), panel: panel(group) }))}
        />
      )}

      <Sheet open={pinRequest !== null} onClose={() => answerPin(null)} title={t("settingsScreen.pinTitle")} closeLabel={t("common.close")}>
        <p>{t("settingsScreen.pinWhy")}</p>
        <PinPad onSubmit={(pin) => answerPin(pin)} labels={{ confirm: t("common.confirm"), backspace: t("common.back"), entered: (count) => `${count}` }} />
      </Sheet>
    </div>
  );

  async function saveMatches() {
    const groupsTouched = new Set(matches.filter((view) => editable(view) && changed(view)).map((view) => view.group));
    for (const group of groupsTouched) await saveGroup(group);
  }
}
