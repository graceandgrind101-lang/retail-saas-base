"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { activeNavItem, flattenNav, phoneTabs, type AdminNav, type NavItem } from "@retail/core";
import type { CalendarKind } from "@retail/i18n";
import { Icon, ModuleHeading, Sheet } from "@retail/ui";
import { AccountSheet } from "./account-sheet";
import { AlertsBell } from "./bell";
import { CommandPalette } from "./command-palette";
import { ImpersonationBanner } from "./impersonation-banner";
import { navIcon } from "./nav-icon";

export interface AdminShellProps {
  nav: AdminNav;
  shopName: string;
  staffName: string;
  roleLabel: string;
  /** Open alerts, or null when the person may not see alerts. */
  alerts: { open: number; hasFraud: boolean } | null;
  /** The shop being looked at by our support team; never set until the console exists. */
  impersonating?: string | null;
  locale: string;
  calendar: CalendarKind;
  children: ReactNode;
}

/**
 * The admin app's frame (docs/SCREENS.md §1.2): a sidebar grouped by module with a CONFIGURATION
 * group, a right rail and the Ctrl+K search on a desktop; a top bar and bottom tabs on a phone.
 * What is in the menu is already narrowed to the shop's modules and the person's permissions.
 */
export function AdminShell({ nav, shopName, staffName, roleLabel, alerts, impersonating, locale, calendar, children }: AdminShellProps) {
  const t = useTranslations();
  const pathname = usePathname();
  const [account, setAccount] = useState(false);
  const [more, setMore] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);

  const all = flattenNav(nav);
  const active = activeNavItem(all, pathname);
  const { tabs, more: moreItems } = phoneTabs(nav);
  const current = (item: NavItem) => (active?.key === item.key ? ("page" as const) : undefined);

  const link = (item: NavItem, onClick?: () => void) => (
    <Link key={item.key} href={item.path} className="shell-link" aria-current={current(item)} onClick={onClick}>
      <Icon name={navIcon(item.key)} />
      {t(`nav.${item.key}`)}
    </Link>
  );

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {t("shell.skipToContent")}
      </a>
      {impersonating ? <ImpersonationBanner message={t("shell.impersonating", { shop: impersonating })} /> : null}
      <div className="shell-frame">
        <aside className="shell-sidebar">
          <button type="button" className="shell-shop" onClick={() => setAccount(true)}>
            <span>{shopName}</span>
            <Icon name="down" size={16} />
          </button>
          <nav className="shell-nav" aria-label={t("shell.navigation")} style={{ marginTop: "var(--space-3)" }}>
            {nav.top.map((item) => link(item))}
            {nav.modules.map((section) => (
              <div className="shell-group" key={section.module}>
                <ModuleHeading module={section.module}>{t(`modules.${section.module}`)}</ModuleHeading>
                {section.items.map((item) => link(item))}
                {section.configuration.length > 0 ? (
                  <>
                    <span className="shell-group-label">{t("shell.configuration")}</span>
                    {section.configuration.map((item) => link(item))}
                  </>
                ) : null}
              </div>
            ))}
            {nav.configuration.length > 0 ? (
              <div className="shell-group">
                <span className="shell-group-label">{t("shell.configuration")}</span>
                {nav.configuration.map((item) => link(item))}
              </div>
            ) : null}
          </nav>
        </aside>

        <div className="shell-column">
          <header className="shell-topbar">
            <button type="button" className="shell-shop" onClick={() => setAccount(true)}>
              <span>{shopName}</span>
              <Icon name="down" size={16} />
            </button>
            <div className="shell-topbar-title">
              {active && active.module !== "core" ? <ModuleHeading module={active.module}>{t(`nav.${active.key}`)}</ModuleHeading> : active ? <strong>{t(`nav.${active.key}`)}</strong> : null}
            </div>
            <button type="button" className="ui-icon-button shell-search" onClick={() => setPalette(true)} aria-label={t("shell.search")}>
              <Icon name="search" />
              <kbd aria-hidden="true">Ctrl K</kbd>
            </button>
            <AlertsBell open={alerts?.open ?? null} hasFraud={alerts?.hasFraud ?? false} />
          </header>
          <main id="main" className="shell-main" tabIndex={-1}>
            {children}
          </main>
        </div>

        <aside className="shell-rail">
          <AlertsBell open={alerts?.open ?? null} hasFraud={alerts?.hasFraud ?? false} />
          <button type="button" className="ui-icon-button" onClick={() => setHelp(true)} aria-label={t("shell.help")}>
            <Icon name="help" size={24} />
          </button>
          <button type="button" className="ui-icon-button" onClick={() => setAccount(true)} aria-label={t("shell.preferences")}>
            <Icon name="gear" size={24} />
          </button>
        </aside>
      </div>

      <nav className="shell-tabs" aria-label={t("shell.navigation")}>
        {tabs.map((item) => (
          <Link key={item.key} href={item.path} className="shell-tab" aria-current={current(item)}>
            <Icon name={navIcon(item.key)} size={24} />
            <span>{t(`nav.${item.key}`)}</span>
          </Link>
        ))}
        <button type="button" className="shell-tab" onClick={() => setMore(true)}>
          <Icon name="dots" size={24} />
          <span>{t("shell.more")}</span>
        </button>
      </nav>

      <Sheet open={more} onClose={() => setMore(false)} title={t("shell.more")} closeLabel={t("common.close")}>
        <nav className="shell-nav" aria-label={t("shell.more")}>
          {moreItems.map((item) => link(item, () => setMore(false)))}
        </nav>
        <div className="shell-account" style={{ marginTop: "var(--space-5)" }}>
          <button type="button" className="shell-link" onClick={() => { setMore(false); setAccount(true); }}>
            <Icon name="gear" />
            {t("shell.preferences")}
          </button>
        </div>
      </Sheet>
      <Sheet open={help} onClose={() => setHelp(false)} title={t("shell.help")} closeLabel={t("common.close")}>
        <p>{t("shell.notBuilt")}</p>
      </Sheet>
      <AccountSheet open={account} onClose={() => setAccount(false)} shopName={shopName} staffName={staffName} roleLabel={roleLabel} locale={locale} calendar={calendar} />
      <CommandPalette items={all} open={palette} onOpenChange={setPalette} />
    </div>
  );
}
