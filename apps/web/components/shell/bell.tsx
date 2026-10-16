"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Icon } from "@retail/ui";

/** The alerts bell with the number of open alerts. The dot is red-toned for fraud, but the number and the label say it too. */
export function AlertsBell({ open, hasFraud }: { open: number | null; hasFraud: boolean }) {
  const t = useTranslations("shell");
  if (open === null) return null;
  return (
    <Link href="/alerts" className="shell-bell" data-fraud={hasFraud ? "true" : "false"} aria-label={t("alertsBellCount", { count: open })}>
      <Icon name="bell" size={24} />
      {open > 0 ? (
        <span className="shell-bell-count" aria-hidden="true">
          {open > 99 ? "99+" : open}
        </span>
      ) : null}
    </Link>
  );
}
