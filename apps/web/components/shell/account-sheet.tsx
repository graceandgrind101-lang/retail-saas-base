"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Sheet } from "@retail/ui";
import type { CalendarKind } from "@retail/i18n";
import { signOutOnServer } from "../../lib/client/api";
import { Preferences } from "./preferences";

export interface AccountSheetProps {
  open: boolean;
  onClose: () => void;
  shopName: string;
  staffName: string;
  roleLabel: string;
  locale: string;
  calendar: CalendarKind;
}

/** The shop, who is signed in, the display choices and sign out. (Switching to another shop needs signing in with an account.) */
export function AccountSheet({ open, onClose, shopName, staffName, roleLabel, locale, calendar }: AccountSheetProps) {
  const t = useTranslations();
  const router = useRouter();

  async function signOut() {
    await signOutOnServer();
    router.replace("/sign-in");
    router.refresh();
  }

  return (
    <Sheet open={open} onClose={onClose} title={shopName} closeLabel={t("common.close")}>
      <div className="shell-account">
        <div className="shell-account-who">
          <strong>{t("shell.signedInAs", { name: staffName })}</strong>
          <small>{roleLabel}</small>
        </div>
        <h3>{t("shell.preferences")}</h3>
        <Preferences locale={locale} calendar={calendar} />
        <Button label={t("shell.signOut")} icon="lock" variant="secondary" onClick={() => void signOut()} />
      </div>
    </Sheet>
  );
}
