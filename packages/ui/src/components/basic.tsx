import { useId, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { Icon, type IconName } from "./icon";

/**
 * The plain building blocks. None of them holds any words: the text is always passed in by the
 * caller, from the message files (docs/SCREENS.md §0.1), so this package needs no translation.
 */

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** The words on the button. Required: an icon alone is never enough (low-literacy rule). */
  label: string;
  icon?: IconName;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "md" | "lg";
  /** Shows progress and ignores presses, so a double tap cannot send twice. */
  loading?: boolean;
}

export function Button({ label, icon, variant = "primary", size = "md", loading = false, disabled, className, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx("ui-button", className)}
      data-variant={variant}
      data-size={size}
      data-loading={loading ? "true" : undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
    >
      {loading ? <span className="ui-spinner" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
      <span>{label}</span>
    </button>
  );
}

/** A big number with its label on a coloured strip, and an optional trend ("▲ 2 more than yesterday"). */
export interface TileProps {
  value: string;
  label: string;
  tone?: "a" | "b" | "c" | "d";
  trend?: { direction: "up" | "down" | "flat"; text: string };
}

export function Tile({ value, label, tone = "a", trend }: TileProps) {
  return (
    <div className="ui-tile" data-tone={tone}>
      <div className="ui-tile-body">
        <div className="ui-tile-value">{value}</div>
        {trend ? (
          <div className="ui-tile-trend" data-direction={trend.direction}>
            <Icon name={trend.direction} size={16} />
            <span>{trend.text}</span>
          </div>
        ) : null}
      </div>
      <div className="ui-tile-strip">{label}</div>
    </div>
  );
}

export interface CardProps {
  title: string;
  /** A coloured strip on the card's top edge, e.g. the alert category it shows. */
  accent?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Card({ title, accent, children, footer }: CardProps) {
  const style = accent ? ({ "--card-accent": accent } as CSSProperties) : undefined;
  const titleId = useId();
  return (
    <section className="ui-card" data-accent={accent ? "true" : undefined} style={style} aria-labelledby={titleId}>
      <header className="ui-card-header" id={titleId}>
        {title}
      </header>
      <div className="ui-card-body">{children}</div>
      {footer ? <footer className="ui-card-footer">{footer}</footer> : null}
    </section>
  );
}

/** One row of a card: a count chip, a label and anything on the right. */
export function CardRow({ count, label, children }: { count?: string; label: string; children?: ReactNode }) {
  return (
    <div className="ui-card-row">
      {count !== undefined ? <span className="ui-card-count">{count}</span> : null}
      <span className="ui-card-label">{label}</span>
      {children ? <span className="ui-card-aside">{children}</span> : null}
    </div>
  );
}

export interface SkeletonProps {
  width?: string;
  height?: string;
}

/** A grey placeholder while something loads. Hidden from screen readers; mark the container `aria-busy`. */
export function Skeleton({ width = "100%", height = "1rem" }: SkeletonProps) {
  return <span className="ui-skeleton" aria-hidden="true" style={{ width, height }} />;
}

export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span className="ui-skeleton-text" aria-hidden="true">
      {Array.from({ length: Math.max(1, lines) }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 && lines > 1 ? "60%" : "100%"} />
      ))}
    </span>
  );
}

/** One fixed colour, icon and label per payment method, everywhere (docs/SCREENS.md U6). */
export const PAYMENT_METHODS = {
  cash: { icon: "cash", token: "--pay-cash" },
  telebirr: { icon: "phone", token: "--pay-telebirr" },
  cbe: { icon: "bank", token: "--pay-cbe" },
  bank: { icon: "bank", token: "--pay-bank" },
  dube: { icon: "credit", token: "--pay-dube" },
} as const satisfies Record<string, { icon: IconName; token: string }>;

export type PaymentMethod = keyof typeof PAYMENT_METHODS;

export function PaymentChip({ method, label }: { method: PaymentMethod; label: string }) {
  return (
    <span className="ui-chip" data-method={method}>
      <Icon name={PAYMENT_METHODS[method].icon} size={16} />
      <span>{label}</span>
    </span>
  );
}

export const ALERT_CATEGORY_NAMES = ["fraud", "suspicion", "error", "alert", "message", "info"] as const;
export type AlertCategoryName = (typeof ALERT_CATEGORY_NAMES)[number];

/** An alert's category as a coloured label (the word is always shown, never colour alone). */
export function CategoryBadge({ category, label }: { category: AlertCategoryName; label: string }) {
  return (
    <span className="ui-badge" data-category={category}>
      {label}
    </span>
  );
}

/** A module's name with its thin accent bar beside it (docs/SCREENS.md §1.2). */
export function ModuleHeading({ module, children }: { module: string; children: ReactNode }) {
  return (
    <h2 className="ui-module-heading" data-module={module}>
      {children}
    </h2>
  );
}
