"use client";

import { useEffect, useRef } from "react";

/**
 * Calls `onIdle` once when nobody has touched the screen for `seconds` (the till's auto-lock,
 * docs/SCREENS.md §1.1). Any tap, key press, scroll or pointer move starts the count again.
 *
 * Browsers slow timers down in a background tab, so when the page comes back into view the time
 * is checked against the clock: a till left overnight with the screen off locks at once on wake-up.
 * `enabled` false (or `seconds` 0) turns it off.
 */
export const IDLE_EVENTS = ["pointerdown", "pointermove", "keydown", "touchstart", "wheel", "scroll"] as const;

export function useIdleTimer({ seconds, onIdle, enabled = true }: { seconds: number; onIdle: () => void; enabled?: boolean }): void {
  const callback = useRef(onIdle);
  callback.current = onIdle;

  useEffect(() => {
    if (!enabled || !(seconds > 0)) return;
    const limit = seconds * 1000;
    let lastActivity = Date.now();
    let fired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fire = () => {
      if (fired) return;
      fired = true;
      if (timer) clearTimeout(timer);
      callback.current();
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, limit);
    };
    const activity = () => {
      if (fired) return;
      lastActivity = Date.now();
      arm();
    };
    const visibility = () => {
      if (document.visibilityState === "visible" && Date.now() - lastActivity >= limit) fire();
    };

    arm();
    for (const name of IDLE_EVENTS) window.addEventListener(name, activity, { passive: true, capture: true });
    document.addEventListener("visibilitychange", visibility);
    return () => {
      if (timer) clearTimeout(timer);
      for (const name of IDLE_EVENTS) window.removeEventListener(name, activity, { capture: true });
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [seconds, enabled]);
}
