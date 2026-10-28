/**
 * Focus for the kit's modal layers (Dialog, Drawer): take the focus when
 * they open, keep Tab inside them, close on Esc, and give the focus back to
 * where it was when they close.
 */
import { useEffect, useRef, type RefObject } from "react";

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The element Tab moves to from the active one in `container`, or null when Tab can go its own way. */
export function trapTarget(container: HTMLElement, active: Element | null, shift: boolean): HTMLElement | null {
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden]"));
  if (items.length === 0) return container;
  const first = items[0];
  const last = items[items.length - 1];
  const inside = active instanceof Node && container.contains(active);
  if (!inside) return shift ? last : first;
  if (shift && (active === first || active === container)) return last;
  if (!shift && active === last) return first;
  return null;
}

/** The open layers, oldest first */
const LAYERS: (HTMLElement | null)[] = [];

/**
 * While mounted: focus `ref` (or its `initial` element), trap Tab in it,
 * call `onClose` on Esc, and restore the focus on unmount. Only the most
 * recently opened layer reacts, so a Dialog over a Drawer closes first.
 */
export function useFocusTrap(ref: RefObject<HTMLElement>, onClose: () => void, initial?: RefObject<HTMLElement>): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    LAYERS.push(node);
    (initial?.current ?? node)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (!node || LAYERS[LAYERS.length - 1] !== node) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const target = trapTarget(node, document.activeElement, event.shiftKey);
      if (target) {
        event.preventDefault();
        target.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const at = LAYERS.lastIndexOf(node);
      if (at >= 0) LAYERS.splice(at, 1);
      if (previous && previous.isConnected) previous.focus();
    };
    // Once per opening: ref and initial are stable refs
  }, []);
}
| null)[] = [];
