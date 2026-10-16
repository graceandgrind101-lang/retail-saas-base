"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Sheet, useToast } from "@retail/ui";
import { postJson } from "@/lib/client/api";

export interface StaffLine {
  id: string;
  name: string;
  status: "invited" | "active" | "suspended" | "archived";
  roleKey: string;
  hasPin: boolean;
  lockedOut: boolean;
}

export function StaffList({
  staff,
  roles,
  selfId,
  canManage,
  canGiveOwner,
}: {
  staff: StaffLine[];
  roles: { id: string; key: string; label: string }[];
  selfId: string;
  canManage: boolean;
  canGiveOwner: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const giveable = roles.filter((r) => r.key !== "owner" || canGiveOwner);
  const [roleId, setRoleId] = useState(giveable.find((r) => r.key === "cashier")?.id ?? giveable[0]?.id ?? "");

  const roleLabel = (key: string, fallback?: string) => (t.has(`roles.${key}`) ? t(`roles.${key}`) : (fallback ?? key));
  const errorText = (code: string | undefined) => (code && t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.server_error"));

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const created = await postJson<{ id?: string }>("/api/staff", { displayName: name, roleId, ...(phone.trim() ? { phone: phone.trim() } : {}) });
    if (!created.ok || !created.data.id) {
      setBusy(false);
      toast.show({ message: errorText(created.data.error), tone: "bad" });
      return;
    }
    if (pin !== "") {
      const set = await postJson("/api/staff/pin", { staffId: created.data.id, pin });
      if (!set.ok) toast.show({ message: errorText(set.data.error), tone: "warn" }); // the person exists; the PIN can be set on their page
    }
    setBusy(false);
    setAdding(false);
    setName("");
    setPhone("");
    setPin("");
    toast.show({ message: t("staff.done"), tone: "ok" });
    router.push(`/staff/${created.data.id}`);
    router.refresh();
  }

  return (
    <div className="ui-stack">
      <h1>{t("staff.title")}</h1>
      {canManage ? <Button label={t("staff.add")} icon="plus" onClick={() => setAdding(true)} /> : null}

      <ul className="directory-list">
        {staff.map((person) => (
          <li key={person.id}>
            <Link href={`/staff/${person.id}`} className="directory-row">
              <span className="directory-main">
                <strong>
                  {person.name} {person.id === selfId ? t("staff.you") : ""}
                </strong>
                <small>{roleLabel(person.roleKey, roles.find((r) => r.key === person.roleKey)?.label)}</small>
              </span>
              <span className="directory-side">
                <span className="directory-tag" data-status={person.status}>
                  {t(`staff.status.${person.status}`)}
                </span>
                <small>{person.lockedOut ? t("staff.lockedOut") : person.hasPin ? t("staff.hasPin") : t("staff.noPin")}</small>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <Sheet open={adding} onClose={() => setAdding(false)} title={t("staff.add")} closeLabel={t("common.close")}>
        <form className="signin-form" onSubmit={(event) => void add(event)}>
          <label>
            {t("staff.name")}
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required autoComplete="off" />
          </label>
          <label>
            {t("staff.role")}
            <select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
              {giveable.map((r) => (
                <option key={r.id} value={r.id}>
                  {roleLabel(r.key, r.label)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("staff.phone")}
            <input value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={32} inputMode="tel" autoComplete="off" />
          </label>
          <label>
            {t("staff.pin")}
            <input value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))} inputMode="numeric" maxLength={6} autoComplete="off" />
          </label>
          <Button label={t("staff.add")} icon="check" type="submit" size="lg" loading={busy} />
        </form>
      </Sheet>
    </div>
  );
}
