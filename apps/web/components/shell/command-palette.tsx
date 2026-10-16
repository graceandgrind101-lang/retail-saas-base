"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { NavItem } from "@retail/core";
import { Icon, Sheet } from "@retail/ui";
import { navIcon } from "./nav-icon";

/**
 * Ctrl+K (or ⌘K) opens a box to jump to any page the person can reach. Only pages for now; records
 * and actions join it as their screens are built. Enter goes to the first match.
 */
export function CommandPalette({ items, open, onOpenChange }: { items: readonly NavItem[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations();
  const router = useRouter();
  const [query, setQuery] = useState("");

  const close = useCallback(() => {
    setQuery("");
    onOpenChange(false);
  }, [onOpenChange]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) close();
        else onOpenChange(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close, onOpenChange]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => needle === "" || t(`nav.${item.key}`).toLowerCase().includes(needle));
  }, [items, query, t]);

  return (
    <Sheet open={open} onClose={close} title={t("shell.search")} closeLabel={t("common.close")} initialFocus=".shell-palette-input">
      <input
        className="shell-palette-input"
        type="search"
        value={query}
        placeholder={t("shell.searchPlaceholder")}
        aria-label={t("shell.search")}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          const first = matches[0];
          if (event.key === "Enter" && first) {
            close();
            router.push(first.path);
          }
        }}
      />
      {matches.length === 0 ? (
        <p>{t("shell.noResults")}</p>
      ) : (
        <ul className="shell-palette-list">
          {matches.map((item) => (
            <li key={item.key}>
              <Link href={item.path} className="shell-link" onClick={close}>
                <Icon name={navIcon(item.key)} />
                {t(`nav.${item.key}`)}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
