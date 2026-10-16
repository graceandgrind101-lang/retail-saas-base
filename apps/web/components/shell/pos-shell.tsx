"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { POS_TABS } from "@retail/core";
import type { CalendarKind } from "@retail/i18n";
import { Button, Icon, useIdleTimer, type IconName } from "@retail/ui";
import { signOutOnServer } from "../../lib/client/api";
import { AlertsBell } from "./bell";

const TAB_ICONS: Record<string, IconName> = { sell: "cart", today: "receipt", parked: "pause", more: "dots" };

export interface PosShellProps {
  deviceName: string;
  staffName: string;
  alerts: { open: number; hasFraud: boolean } | null;
  /** Seconds of quiet before the till locks itself; 0 turns it off. */
  idleSeconds: number;
  locale: string;
  calendar: CalendarKind;
  children: ReactNode;
}

/**
 * The till's frame (docs/SCREENS.md §1.1): device and cashier in the header, a Lock button, and four
 * tabs. It locks itself after a quiet time (sign-out on the server, then back to the PIN screen), and
 * when the screen wakes after being left alone for longer than that.
 */
export function PosShell({ deviceName, staffName, alerts, idleSeconds, children }: PosShellProps) {
  const t = useTranslations();
  const pathname = usePathname();
  const router = useRouter();
  const [locking, setLocking] = useState(false);

  async function lock(reason: "manual" | "idle") {
    if (locking) return;
    setLocking(true);
    await signOutOnServer();
    router.replace(reason === "idle" ? "/sign-in?locked=idle" : "/sign-in");
  }
  useIdleTimer({ seconds: idleSeconds, onIdle: () => void lock("idle") });

  const currentTab = [...POS_TABS].sort((a, b) => b.path.length - a.path.length).find((tab) => (tab.path === "/pos" ? pathname === "/pos" : pathname === tab.path || pathname.startsWith(`${tab.path}/`)));

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {t("shell.skipToContent")}
      </a>
      <header className="pos-header">
        <Button label={t("pos.lock")} icon="lock" variant="secondary" onClick={() => void lock("manual")} loading={locking} />
        <div className="pos-header-who">
          {deviceName} · {t("pos.cashier", { name: staffName })}
        </div>
        <AlertsBell open={alerts?.open ?? null} hasFraud={alerts?.hasFraud ?? false} />
      </header>
      <main id="main" className="shell-main" tabIndex={-1}>
        {children}
      </main>
      <nav className="shell-tabs" data-always="true" aria-label={t("shell.navigation")}>
        {POS_TABS.map((tab) => (
          <Link key={tab.key} href={tab.path} className="shell-tab" aria-current={currentTab?.key === tab.key ? "page" : undefined}>
            <Icon name={TAB_ICONS[tab.key] ?? "menu"} size={24} />
            <span>{t(`pos.tabs.${tab.key}`)}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
