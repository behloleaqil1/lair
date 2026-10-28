/**
 * Toasts: short notes about something that just happened ("Saved",
 * "Restart requested"), at the bottom corner. A live region, so screen
 * readers say them without moving the focus; a danger toast is an alert.
 * Each closes by itself after `timeout` ms (0: stays until closed) and has a
 * close button. ToastProvider holds them; useToast().show() adds one.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { TONE_ICON, type Tone } from "./tokens";

export interface ToastOptions {
  tone?: Tone;
  /** ms before it closes by itself; 0 keeps it */
  timeout?: number;
}

interface ToastItem {
  id: number;
  message: ReactNode;
  tone: Tone;
  timeout: number;
}

interface ToastApi {
  show: (message: ReactNode, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => -1, dismiss: () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export const DEFAULT_TOAST_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback((message: ReactNode, options: ToastOptions = {}) => {
    const id = next.current++;
    setItems((all) => [...all, { id, message, tone: options.tone ?? "neutral", timeout: options.timeout ?? DEFAULT_TOAST_MS }]);
    return id;
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastRegion items={items} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function ToastRegion({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {items.map((item) => (
        <Toast key={item.id} item={item} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (item.timeout <= 0) return;
    const timer = setTimeout(() => onDismiss(item.id), item.timeout);
    return () => clearTimeout(timer);
  }, [item.id, item.timeout, onDismiss]);
  return (
    <div className={`toast toast-${item.tone}`} role={item.tone === "danger" ? "alert" : "status"} data-toast={item.id}>
      <Icon name={TONE_ICON[item.tone]} className="toast-icon" />
      <div className="toast-message">{item.message}</div>
      <button type="button" className="btn btn-ghost btn-sm icon-button" aria-label="Dismiss" onClick={() => onDismiss(item.id)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
