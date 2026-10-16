"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { DEVICE_KINDS_FOR_FORM, type DeviceKindForForm } from "./kinds";
import type { CalendarKind } from "@retail/i18n";
import { Button, PinPad, useToast } from "@retail/ui";
import { Preferences } from "@/components/shell/preferences";
import { postJson } from "@/lib/client/api";

interface Person {
  id: string;
  name: string;
  locked: boolean;
}

export interface SignInFlowProps {
  locale: string;
  calendar: CalendarKind;
  /** The till locked itself (or was locked) a moment ago. */
  locked: boolean;
  showDev: boolean;
  /** This browser's connected device, or null if it has none. */
  device: { name: string; shop: string } | null;
  staff: Person[];
}

/**
 * Getting in. On a connected device: pick yourself, type your PIN. On a device that is not connected
 * yet: type the code a manager gave you. The developer button exists only on your own computer.
 */
export function SignInFlow({ locale, calendar, locked, showDev, device, staff }: SignInFlowProps) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [person, setPerson] = useState<Person | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<DeviceKindForForm>("pos");

  const errorText = (key: string | undefined) => (key && t.has(`errors.${key}`) ? t(`errors.${key}`) : t("errors.server_error"));

  async function submitPin(pin: string) {
    if (!person) return;
    setBusy(true);
    const result = await postJson("/api/devices/pin-sign-in", { staffId: person.id, pin });
    if (!result.ok) {
      setBusy(false);
      setErrorKey((n) => n + 1);
      toast.show({ message: errorText(result.data.error), tone: "bad" });
      if (result.data.error === "device_unknown" || result.data.error === "locked") router.refresh();
      return;
    }
    const me = await fetch("/api/auth/me").then((r) => r.json() as Promise<{ permissions?: string[] }>).catch(() => ({ permissions: [] as string[] }));
    router.replace(me.permissions?.includes("sale:create") ? "/pos" : "/");
    router.refresh();
  }

  async function pair(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await postJson("/api/devices/pair", { code, name, kind });
    setBusy(false);
    if (!result.ok) {
      toast.show({ message: errorText(result.data.error), tone: "bad" });
      return;
    }
    router.refresh();
  }

  async function devSignIn() {
    setBusy(true);
    const result = await postJson("/api/dev/sign-in");
    setBusy(false);
    if (!result.ok) {
      toast.show({ message: errorText(result.data.error), tone: "bad" });
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="signin">
      <h1>{t("signIn.title")}</h1>
      {locked ? <p className="signin-notice">{t("pos.idleLocked")}</p> : null}

      {device && !person ? (
        <section className="ui-stack" aria-label={t("signIn.whoAreYou")}>
          <p>
            <strong>{device.shop}</strong> · {device.name}
          </p>
          <h2>{t("signIn.whoAreYou")}</h2>
          {staff.length === 0 ? (
            <p className="signin-notice">{t("signIn.noStaff")}</p>
          ) : (
            <div className="signin-people">
              {staff.map((p) => (
                <button key={p.id} type="button" className="signin-person" disabled={p.locked} onClick={() => setPerson(p)}>
                  <span>{p.name}</span>
                  {p.locked ? <span>{t("signIn.locked")}</span> : null}
                </button>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {device && person ? (
        <section className="ui-stack" aria-label={t("pin.title")}>
          <h2>{person.name}</h2>
          <p>{t("pin.title")}</p>
          <PinPad
            key={person.id}
            onSubmit={(pin) => void submitPin(pin)}
            disabled={busy}
            errorKey={errorKey}
            labels={{ confirm: t("common.confirm"), backspace: t("common.back"), entered: (count) => `${count}` }}
          />
          <Button label={t("signIn.changePerson")} variant="ghost" onClick={() => setPerson(null)} />
        </section>
      ) : null}

      {!device ? (
        <form className="signin-form" onSubmit={(event) => void pair(event)}>
          <h2>{t("signIn.pairTitle")}</h2>
          <p>{t("signIn.pairIntro")}</p>
          <label>
            {t("signIn.code")}
            <input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={16} required />
          </label>
          <label>
            {t("signIn.deviceName")}
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("signIn.deviceNameHint")} maxLength={60} required />
          </label>
          <label>
            {t("signIn.kind")}
            <select value={kind} onChange={(event) => setKind(event.target.value as DeviceKindForForm)}>
              {DEVICE_KINDS_FOR_FORM.map((k) => (
                <option key={k} value={k}>
                  {t(`signIn.kinds.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <Button label={t("signIn.pair")} icon="check" type="submit" size="lg" loading={busy} />
        </form>
      ) : null}

      <p className="signin-notice">{t("signIn.adminSoon")}</p>

      {showDev ? (
        <section className="signin-dev" aria-label={t("signIn.devHeading")}>
          <h2>{t("signIn.devHeading")}</h2>
          <Button label={t("signIn.devOwner")} variant="secondary" loading={busy} onClick={() => void devSignIn()} />
        </section>
      ) : null}

      <Preferences locale={locale} calendar={calendar} />
    </main>
  );
}
