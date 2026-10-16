"use client";

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icon";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** The accessible name of the close button, in the person's language. */
  closeLabel: string;
  /** What to focus on opening, as a CSS selector inside the panel (a search box, say). Default: the first control, the close button. */
  initialFocus?: string;
  /** From the bottom on a phone, from the right on a wide screen (the side panel opens a record without leaving the list). */
  children: ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A panel over the page: a bottom sheet on a phone, a side panel on a desktop. A modal dialog:
 * the page behind cannot be reached, Tab stays inside, Escape or a tap outside closes it, and
 * focus returns to where it was when it closes.
 */
export function Sheet({ open, onClose, title, closeLabel, initialFocus, children }: SheetProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const wanted = initialFocus ? panel.current?.querySelector<HTMLElement>(initialFocus) : null;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (wanted ?? first ?? panel.current)?.focus();
    return () => {
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, [open, initialFocus]);

  if (!open || typeof document === "undefined") return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const firstItem = items[0] as HTMLElement;
    const lastItem = items[items.length - 1] as HTMLElement;
    if (event.shiftKey && document.activeElement === firstItem) {
      event.preventDefault();
      lastItem.focus();
    } else if (!event.shiftKey && document.activeElement === lastItem) {
      event.preventDefault();
      firstItem.focus();
    }
  };

  return createPortal(
    <div className="ui-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()} onKeyDown={onKeyDown}>
      <div ref={panel} className="ui-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="ui-sheet-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="ui-icon-button" onClick={onClose} aria-label={closeLabel}>
            <Icon name="close" />
          </button>
        </header>
        <div className="ui-sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
