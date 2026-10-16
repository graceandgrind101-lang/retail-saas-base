"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { PERMISSION_KEYS } from "@retail/core";
import { permissionMessagePath as pathOf } from "@retail/i18n";
import { Button, HoldToConfirm, PinPad, Sheet, useToast } from "@retail/ui";
import { useFormat } from "@/components/format-context";
import { RecordTimeline } from "@/components/timeline";
import { postJson } from "@/lib/client/api";
import type { ActivityLine } from "@/lib/activity/sentence";


export interface MemberData {
  id: string;
  name: string;
  phone: string | null;
  status: "invited" | "active" | "suspended" | "archived";
  roleId: string;
  roleKey: string;
  hasPin: boolean;
  lockedOut: boolean;
  createdAt: string;
}

export function StaffDetail({
  member,
  isSelf,
  canManage,
  canGiveOwner,
  permissions,
  overrides,
  roles,
  activity,
}: {
  member: MemberData;
  isSelf: boolean;
  canManage: boolean;
  canGiveOwner: boolean;
  permissions: string[];
  overrides: { key: string; effect: "allow" | "deny"; reason: string; grantedBy: string | null }[];
  roles: { id: string; key: string; label: string }[];
  activity: ActivityLine[];
}) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const format = useFormat();
  const [busy, setBusy] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [roleId, setRoleId] = useState(member.roleId);
  const [overrideKey, setOverrideKey] = useState<string>(PERMISSION_KEYS[0] ?? "");
  const [overrideEffect, setOverrideEffect] = useState<"allow" | "deny">("deny");
  const [reason, setReason] = useState("");

  const roleLabel = (key: string, fallback?: string) => (t.has(`roles.${key}`) ? t(`roles.${key}`) : (fallback ?? key));
  const errorText = (code: string | undefined) => (code && t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.server_error"));
  const manageable = canManage && !isSelf && member.status !== "archived";
  const giveable = roles.filter((r) => r.key !== "owner" || canGiveOwner);

  async function run(path: string, body: unknown, after?: () => void) {
    setBusy(true);
    const result = await postJson(path, body);
    setBusy(false);
    if (!result.ok) {
      toast.show({ message: errorText(result.data.error), tone: "bad" });
      return false;
    }
    toast.show({ message: t("staff.done"), tone: "ok" });
    after?.();
    router.refresh();
    return true;
  }

  return (
    <div className="ui-stack">
      <Link className="ui-link" href="/staff">
        {t("staff.back")}
      </Link>
      <h1>
        {member.name} {isSelf ? t("staff.you") : ""}
      </h1>
      <div className="directory-meta">
        <span className="directory-tag" data-status={member.status}>
          {t(`staff.status.${member.status}`)}
        </span>
        <span>{roleLabel(member.roleKey, roles.find((r) => r.id === member.roleId)?.label)}</span>
        <span>{member.lockedOut ? t("staff.lockedOut") : member.hasPin ? t("staff.hasPin") : t("staff.noPin")}</span>
        <span>{t("staff.addedOn", { date: format.date(member.createdAt) })}</span>
        {member.phone ? <span>{member.phone}</span> : null}
      </div>

      <div className="directory-actions">
        {(isSelf || manageable) && member.status === "active" ? <Button label={t("staff.setPin")} icon="lock" variant="secondary" onClick={() => setPinOpen(true)} /> : null}
        {manageable && member.status === "active" ? <Button label={t("staff.suspend")} variant="secondary" loading={busy} onClick={() => void run("/api/staff/status", { staffId: member.id, status: "suspended" })} /> : null}
        {manageable && member.status === "suspended" ? <Button label={t("staff.reinstate")} icon="check" loading={busy} onClick={() => void run("/api/staff/status", { staffId: member.id, status: "active" })} /> : null}
        {manageable ? <Button label={t("staff.archive")} variant="danger" icon="close" onClick={() => setArchiveOpen(true)} /> : null}
      </div>

      {manageable && member.status !== "invited" ? (
        <section className="ui-stack" aria-label={t("staff.changeRole")}>
          <h2>{t("staff.changeRole")}</h2>
          <label className="directory-inline">
            <span className="ui-sr-only">{t("staff.role")}</span>
            <select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
              {giveable.map((r) => (
                <option key={r.id} value={r.id}>
                  {roleLabel(r.key, r.label)}
                </option>
              ))}
            </select>
          </label>
          <Button label={t("staff.changeRole")} variant="secondary" loading={busy} disabled={roleId === member.roleId} onClick={() => void run("/api/staff/role", { staffId: member.id, roleId })} />
        </section>
      ) : null}

      <section className="ui-stack" aria-label={t("staff.permissionsTitle")}>
        <h2>{t("staff.permissionsTitle")}</h2>
        {permissions.length === 0 ? (
          <p>—</p>
        ) : (
          <ul className="chips">
            {permissions.map((key) => (
              <li key={key}>{t.has(pathOf(key)) ? t(pathOf(key)) : key}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="ui-stack" aria-label={t("staff.overridesTitle")}>
        <h2>{t("staff.overridesTitle")}</h2>
        {overrides.length === 0 ? <p>{t("staff.noOverrides")}</p> : null}
        <ul className="directory-list">
          {overrides.map((o) => (
            <li key={o.key} className="directory-row">
              <span className="directory-main">
                <strong>{t.has(pathOf(o.key)) ? t(pathOf(o.key)) : o.key}</strong>
                <small>
                  {o.effect === "allow" ? t("staff.allow") : t("staff.deny")} · {o.reason}
                </small>
              </span>
              {manageable ? <Button label={t("staff.remove")} variant="ghost" loading={busy} onClick={() => void run("/api/staff/overrides/remove", { staffId: member.id, key: o.key })} /> : null}
            </li>
          ))}
        </ul>
        {manageable ? (
          <form
            className="signin-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run("/api/staff/overrides", { staffId: member.id, key: overrideKey, effect: overrideEffect, reason }, () => setReason(""));
            }}
          >
            <h3>{t("staff.addOverride")}</h3>
            <label>
              {t("staff.permission")}
              <select value={overrideKey} onChange={(event) => setOverrideKey(event.target.value)}>
                {PERMISSION_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {t.has(pathOf(key)) ? t(pathOf(key)) : key}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("staff.effect")}
              <select value={overrideEffect} onChange={(event) => setOverrideEffect(event.target.value as "allow" | "deny")}>
                <option value="allow">{t("staff.allow")}</option>
                <option value="deny">{t("staff.deny")}</option>
              </select>
            </label>
            <label>
              {t("staff.reason")}
              <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={300} required />
            </label>
            <Button label={t("staff.addOverride")} icon="plus" type="submit" variant="secondary" loading={busy} />
          </form>
        ) : null}
      </section>

      {activity.length > 0 || canManage ? (
        <section className="ui-stack" aria-label={t("activity.recent")}>
          <h2>{t("activity.recent")}</h2>
          <RecordTimeline lines={activity} />
        </section>
      ) : null}

      <Sheet open={pinOpen} onClose={() => setPinOpen(false)} title={t("staff.setPin")} closeLabel={t("common.close")}>
        <p>{t("staff.newPin")}</p>
        <PinPad
          onSubmit={(pin) => void run("/api/staff/pin", { staffId: member.id, pin }, () => setPinOpen(false))}
          disabled={busy}
          labels={{ confirm: t("common.confirm"), backspace: t("common.back"), entered: (count) => `${count}` }}
        />
      </Sheet>
      <Sheet open={archiveOpen} onClose={() => setArchiveOpen(false)} title={t("staff.archive")} closeLabel={t("common.close")}>
        <p>{t("staff.archiveWhy")}</p>
        <HoldToConfirm label={t("staff.archive")} variant="danger" onConfirm={() => void run("/api/staff/status", { staffId: member.id, status: "archived" }, () => setArchiveOpen(false))} />
      </Sheet>
    </div>
  );
}
