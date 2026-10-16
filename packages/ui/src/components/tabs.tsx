"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface TabItem {
  id: string;
  label: string;
  panel: ReactNode;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  /** Controlled: the selected tab's id. Leave out to let Tabs remember it. */
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  /** What the group of tabs is (read out by screen readers). */
  ariaLabel: string;
}

/**
 * Tabs as the WAI-ARIA pattern describes: arrow keys move between tabs, Home and End jump, only
 * the selected tab is in the tab order. Used for the saved views above a list ("Low stock", ...).
 */
export function Tabs({ tabs, value, defaultValue, onChange, ariaLabel }: TabsProps) {
  const base = useId();
  const [inner, setInner] = useState(defaultValue ?? tabs[0]?.id ?? "");
  const selected = value ?? inner;
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = (id: string) => {
    if (value === undefined) setInner(id);
    onChange?.(id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1;
    const target = event.key === "ArrowRight" ? (index === last ? 0 : index + 1) : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (target === null) return;
    event.preventDefault();
    const next = tabs[target];
    if (!next) return;
    select(next.id);
    refs.current[next.id]?.focus();
  };

  return (
    <div className="ui-tabs">
      <div role="tablist" aria-label={ariaLabel} className="ui-tablist">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[tab.id] = el;
            }}
            role="tab"
            type="button"
            id={`${base}-tab-${tab.id}`}
            aria-selected={tab.id === selected}
            aria-controls={`${base}-panel-${tab.id}`}
            tabIndex={tab.id === selected ? 0 : -1}
            className="ui-tab"
            onClick={() => select(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} role="tabpanel" id={`${base}-panel-${tab.id}`} aria-labelledby={`${base}-tab-${tab.id}`} hidden={tab.id !== selected} className="ui-tabpanel" tabIndex={0}>
          {tab.id === selected ? tab.panel : null}
        </div>
      ))}
    </div>
  );
}
