"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { Button, cx } from "./basic";
import { Icon } from "./icon";
import { DEFAULT_KEYPAD_RULES, applyKey, type KeypadRules } from "./keypad-logic";

/**
 * Input made for a thumb: big keys, no typing on a phone's small keyboard (PLAN.md §3). None of
 * these holds words; the caller passes the labels in its language.
 */

export interface KeypadProps {
  /** The amount typed so far, as text such as `1250.5`. */
  value: string;
  onChange: (next: string) => void;
  rules?: KeypadRules;
  /** The accessible name of the delete key. */
  backspaceLabel: string;
  disabled?: boolean;
}

/** The amount keypad of the sale screen. Layout 7-8-9 / 4-5-6 / 1-2-3 / point-0-delete. */
export function Keypad({ value, onChange, rules = DEFAULT_KEYPAD_RULES, backspaceLabel, disabled }: KeypadProps) {
  const press = (key: string) => onChange(applyKey(value, key, rules));
  const digit = (d: string) => (
    <button key={d} type="button" className="ui-key" onClick={() => press(d)} disabled={disabled}>
      {d}
    </button>
  );
  return (
    <div className="ui-keypad" role="group">
      {["7", "8", "9", "4", "5", "6", "1", "2", "3"].map(digit)}
      <button type="button" className="ui-key" onClick={() => press(".")} disabled={disabled || rules.decimals === 0} aria-hidden={rules.decimals === 0 ? "true" : undefined}>
        .
      </button>
      {digit("0")}
      <button type="button" className="ui-key" onClick={() => press("backspace")} disabled={disabled} aria-label={backspaceLabel}>
        <Icon name="backspace" size={26} />
      </button>
    </div>
  );
}

export interface PinPadProps {
  /** Called with the PIN when the person confirms. The pad then clears itself. */
  onSubmit: (pin: string) => void;
  minLength?: number;
  maxLength?: number;
  /** Accessible texts, in the person's language. */
  labels: { confirm: string; backspace: string; entered: (count: number) => string };
  disabled?: boolean;
  /** Shakes the dots once (a wrong PIN). Change the value to shake again. */
  errorKey?: number;
}

/**
 * The PIN pad. The digits typed show only as dots and are never written into the page text, so
 * they cannot be read over a shoulder or by a screen recorder of the DOM; nothing is stored.
 */
export function PinPad({ onSubmit, minLength = 4, maxLength = 6, labels, disabled, errorKey }: PinPadProps) {
  const [digits, setDigits] = useState("");

  const add = (d: string) => setDigits((current) => (current.length < maxLength ? current + d : current));
  const submit = () => {
    if (disabled || digits.length < minLength) return;
    const pin = digits;
    setDigits("");
    onSubmit(pin);
  };

  const key = (d: string) => (
    <button key={d} type="button" className="ui-key" onClick={() => add(d)} disabled={disabled}>
      {d}
    </button>
  );

  return (
    <div className="ui-pinpad">
      <div className="ui-pin-dots" role="img" aria-label={labels.entered(digits.length)} data-error={errorKey ? String(errorKey) : undefined} key={`dots-${errorKey ?? 0}`}>
        {Array.from({ length: maxLength }, (_, i) => (
          <span key={i} className="ui-pin-dot" data-filled={i < digits.length ? "true" : "false"} />
        ))}
      </div>
      <div className="ui-keypad" role="group">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(key)}
        <span aria-hidden="true" />
        {key("0")}
        <button type="button" className="ui-key" onClick={() => setDigits((current) => current.slice(0, -1))} disabled={disabled} aria-label={labels.backspace}>
          <Icon name="backspace" size={26} />
        </button>
      </div>
      <Button label={labels.confirm} icon="check" size="lg" onClick={submit} disabled={disabled || digits.length < minLength} />
    </div>
  );
}

export interface HoldToConfirmProps {
  label: string;
  /** Said while the button is held, e.g. "Keep holding…". */
  holdingLabel?: string;
  onConfirm: () => void;
  /** How long to hold. Long enough that a stray touch cannot confirm. Default 800. */
  durationMs?: number;
  disabled?: boolean;
  variant?: "primary" | "danger";
}

/**
 * A deliberate confirm: press and HOLD until the bar fills (PLAN.md §3, "deliberate confirm on
 * sale"). Letting go early cancels. Works with a finger, a mouse and the keyboard (hold Space or Enter).
 */
export function HoldToConfirm({ label, holdingLabel, onConfirm, durationMs = 800, disabled, variant = "primary" }: HoldToConfirmProps) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirm = useRef(onConfirm);
  confirm.current = onConfirm;

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  const start = () => {
    if (disabled || timer.current) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      confirm.current();
    }, durationMs);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const down = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === " " || event.key === "Enter") && !event.repeat) {
      event.preventDefault();
      start();
    }
  };
  const up = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === " " || event.key === "Enter") stop();
  };

  return (
    <button
      type="button"
      className={cx("ui-hold")}
      data-variant={variant}
      data-holding={holding ? "true" : "false"}
      style={{ "--hold-ms": `${durationMs}ms` } as CSSProperties}
      disabled={disabled}
      onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        start();
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={down}
      onKeyUp={up}
      onBlur={stop}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span className="ui-hold-fill" aria-hidden="true" />
      <span className="ui-hold-label">
        <Icon name="check" />
        <span>{holding && holdingLabel ? holdingLabel : label}</span>
      </span>
    </button>
  );
}
