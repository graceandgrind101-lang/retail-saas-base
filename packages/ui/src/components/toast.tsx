import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icon";

export type ToastTone = "info" | "ok" | "warn" | "bad";

export interface ToastInput {
  message: string;
  tone?: ToastTone;
  /** Milliseconds before it goes away by itself. Default 4000; 0 keeps it until dismissed. */
  durationMs?: number;
}

interface ToastItem extends Required<Omit<ToastInput, "durationMs">> {
  id: number;
  durationMs: number;
}

interface ToastApi {
  show: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Show a short message that never blocks the screen (PLAN.md §3: no modal error walls). */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast needs a <ToastProvider> above it");
  return api;
}

function ToastView({ toast, dismissLabel, onDismiss }: { toast: ToastItem; dismissLabel: string; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (toast.durationMs <= 0) return;
    const timer = setTimeout(() => onDismiss(toast.id), toast.durationMs);
    return () => clearTimeout(timer);
  }, [toast.id, toast.durationMs, onDismiss]);

  return (
    <div className="ui-toast" data-tone={toast.tone}>
      <span>{toast.message}</span>
      <button type="button" className="ui-icon-button" onClick={() => onDismiss(toast.id)} aria-label={dismissLabel}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

/**
 * Put once near the top of the app. `dismissLabel` is the accessible name of the close button.
 * The messages are announced politely by screen readers; they never take focus.
 */
export function ToastProvider({ children, dismissLabel }: { children: ReactNode; dismissLabel: string }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setItems((current) => current.filter((t) => t.id !== id)), []);
  const show = useCallback((toast: ToastInput) => {
    const id = next.current++;
    setItems((current) => [...current.slice(-3), { id, message: toast.message, tone: toast.tone ?? "info", durationMs: toast.durationMs ?? 4000 }]);
    return id;
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="ui-toast-region" role="status" aria-live="polite">
        {items.map((toast) => (
          <ToastView key={toast.id} toast={toast} dismissLabel={dismissLabel} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
