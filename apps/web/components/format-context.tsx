"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useLocale, useMessages } from "next-intl";
import { formatDate, formatDateTime, formatTime, type CalendarKind, type Messages } from "@retail/i18n";

const Context = createContext<{ calendar: CalendarKind; timeZone: string } | null>(null);

/** Tells every screen below which calendar and time zone to show dates in (the person's choice, else the shop's). */
export function FormatProvider({ calendar, timeZone, children }: { calendar: CalendarKind; timeZone: string; children: ReactNode }) {
  const value = useMemo(() => ({ calendar, timeZone }), [calendar, timeZone]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** `date("2026-10-16T...")`, `dateTime(...)`, `time(...)`: in the person's language, calendar and the shop's time zone. */
export function useFormat() {
  const context = useContext(Context);
  if (!context) throw new Error("useFormat needs a <FormatProvider> above it");
  const locale = useLocale();
  const messages = useMessages() as unknown as Messages;
  return useMemo(() => {
    const options = { locale, calendar: context.calendar, timeZone: context.timeZone, messages };
    return {
      date: (iso: string | Date) => formatDate(new Date(iso), options),
      dateTime: (iso: string | Date) => formatDateTime(new Date(iso), options),
      time: (iso: string | Date) => formatTime(new Date(iso), context.timeZone),
    };
  }, [context, locale, messages]);
}
