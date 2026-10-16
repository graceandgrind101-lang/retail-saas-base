"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, HoldToConfirm, Sheet, useToast } from "@retail/ui";
import { useFormat } from "@/components/format-context";
import { postJson } from "@/lib/client/api";

export interface DeviceLine {
  id: string;
  name: string;
  kind: "pos" | "phone" | "tablet" | "desktop";
  branch: string;
  pairedAt: string;
  pairedBy: string | null;
  lastSeenAt: string | null;
  revoked: boolean;
  lockedUntil: string | null;
}

export function DevicesView({ devices, branchId }: { devices: DeviceLine[]; branchId: string | null }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const format = useFormat();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [revoking, setRevoking] = useState<DeviceLine | null>(null);
  const errorText = (key: string | undefined) => (key && t.has(`errors.${key}`) ? t(`errors.${key}`) : t("errors.server_error"));

  async function makeCode() {
    if (!branchId) return;
    setBusy(true);
    const result = await postJson<{ code?: string; expiresAt?: string }>("/api/devices/pairing-codes", { branchId });
    setBusy(false);
    if (!result.ok || !result.data.code || !result.data.expiresAt) {
      toast.show({ message: errorText(result.data.error), tone: "bad" });
      return;
    }
    setCode({ code: result.data.code, expiresAt: result.data.expiresAt });
    router.refresh();
  }

  async function act(path: string, deviceId: string, done: () => void) {
    setBusy(true);
    const result = await postJson(path, { deviceId });
    setBusy(false);
    if (!result.ok) {
      toast.show({ message: errorText(result.data.error), tone: "bad" });
      return;
    }
    toast.show({ message: t("staff.done"), tone: "ok" });
    done();
    router.refresh();
  }

  return (
    <div className="ui-stack">
      <h1>{t("devices.title")}</h1>
      <Button label={t("devices.pair")} icon="plus" loading={busy && code === null} disabled={!branchId} onClick={() => void makeCode()} />

      {devices.length === 0 ? <p>{t("devices.empty")}</p> : null}
      <ul className="directory-list">
        {devices.map((device) => (
          <li key={device.id} className="directory-row" data-revoked={device.revoked ? "true" : "false"}>
            <span className="directory-main">
              <strong>{device.name}</strong>
              <small>
                {t(`signIn.kinds.${device.kind}`)} · {device.branch}
              </small>
              <small>{t("devices.pairedBy", { name: device.pairedBy ?? "", date: format.date(device.pairedAt) })}</small>
              <small>{device.lastSeenAt ? t("devices.lastSeen", { date: format.dateTime(device.lastSeenAt) }) : t("devices.neverUsed")}</small>
            </span>
            <span className="directory-side">
              <span className="directory-tag" data-status={device.revoked ? "archived" : "active"}>
                {device.revoked ? t("devices.revoked") : t("devices.connected")}
              </span>
              {device.lockedUntil && !device.revoked ? <small>{t("devices.locked", { time: format.time(device.lockedUntil) })}</small> : null}
              {device.lockedUntil && !device.revoked ? <Button label={t("devices.unlock")} variant="secondary" loading={busy} onClick={() => void act("/api/devices/unlock", device.id, () => undefined)} /> : null}
              {!device.revoked ? <Button label={t("devices.revoke")} variant="ghost" onClick={() => setRevoking(device)} /> : null}
            </span>
          </li>
        ))}
      </ul>

      <Sheet open={code !== null} onClose={() => setCode(null)} title={t("devices.pair")} closeLabel={t("common.close")}>
        {code ? (
          <div className="ui-stack">
            <p>{t("devices.pairIntro")}</p>
            <p className="pair-code" aria-label={t("devices.code")}>
              {code.code}
            </p>
            <p>{t("devices.validUntil", { time: format.time(code.expiresAt) })}</p>
          </div>
        ) : null}
      </Sheet>
      <Sheet open={revoking !== null} onClose={() => setRevoking(null)} title={revoking ? `${t("devices.revoke")}: ${revoking.name}` : ""} closeLabel={t("common.close")}>
        <p>{t("devices.revokeWhy")}</p>
        {revoking ? <HoldToConfirm label={t("devices.revoke")} variant="danger" onConfirm={() => void act("/api/devices/revoke", revoking.id, () => setRevoking(null))} /> : null}
      </Sheet>
    </div>
  );
}
