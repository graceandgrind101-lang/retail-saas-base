import type { ReactNode } from "react";

/**
 * The few icons the interface needs (every action has an icon AND a short label, PLAN.md §3).
 * Drawn on a 24-unit grid with a 2-unit stroke so they take the colour and size of their text.
 */
const PATHS: Record<string, ReactNode> = {
  cash: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  bank: (
    <>
      <path d="M3 10 12 4l9 6" />
      <path d="M5 10v8M10 10v8M14 10v8M19 10v8M3 20h18" />
    </>
  ),
  credit: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </>
  ),
  check: <path d="m5 12 5 5 9-10" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  up: <path d="m6 14 6-6 6 6" />,
  down: <path d="m6 10 6 6 6-6" />,
  flat: <path d="M5 12h14" />,
  bell: <path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  backspace: <path d="M21 5H9l-6 7 6 7h12zM13 9l4 6M17 9l-4 6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.5-4.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
};

export type IconName = keyof typeof PATHS;

export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** Decorative: the label next to it carries the meaning, so screen readers skip it. */
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg className="ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
