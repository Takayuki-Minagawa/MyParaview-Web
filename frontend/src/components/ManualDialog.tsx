import { useEffect, useRef, type KeyboardEvent } from "react";
import { useMessages } from "../i18n-context";
import type { AppMode } from "../lib/appMode";

interface Props {
  open: boolean;
  mode: AppMode;
  onClose: () => void;
}

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled])", "select:not([disabled])",
  "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

export function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((element) => !element.hasAttribute("hidden") && element.tabIndex !== -1);
}

/** Decide where Tab / Shift+Tab should land so focus cycles inside `root`.
 * Returns null when the browser's default move stays inside the dialog. */
export function nextTrappedFocus(
  root: HTMLElement,
  active: Element | null,
  shiftKey: boolean,
): HTMLElement | null {
  const elements = focusableElements(root);
  if (elements.length === 0) return root;
  const first = elements[0];
  const last = elements[elements.length - 1];
  const inside = active instanceof HTMLElement && root.contains(active);
  if (!inside) return shiftKey ? last : first;
  if (shiftKey && active === first) return last;
  if (!shiftKey && active === last) return first;
  return null;
}

/** Modal quick guide with a focus trap, Escape from any inner element, and
 * focus restoration to the element that opened it (feedback F-05). */
export function ManualDialog({ open, mode, onClose }: Props) {
  const t = useMessages();
  const dialogRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    const initial = dialog ? focusableElements(dialog)[0] ?? dialog : null;
    initial?.focus();
    return () => {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener && opener.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab" && dialogRef.current) {
      const target = nextTrappedFocus(dialogRef.current, document.activeElement, event.shiftKey);
      if (target) {
        event.preventDefault();
        target.focus();
      }
    }
  };

  const steps = mode === "server" ? t.manual.serverSteps : t.manual.staticSteps;

  return (
    <div
      className="manual-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <section
        ref={dialogRef}
        className="manual-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-title"
        aria-describedby="manual-intro"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="manual-header">
          <h2 id="manual-title">{t.manual.title}</h2>
          <button type="button" onClick={onClose}>{t.common.close}</button>
        </div>
        <p className="muted">
          {t.manual.currentMode}: {mode === "server" ? t.connection.modeServer : t.connection.modeStatic}
        </p>
        <p id="manual-intro">{t.manual.intro}</p>
        <ol>
          {steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <h3>{t.manual.availabilityTitle}</h3>
        <ul className="manual-availability">
          <li>{t.manual.availableInBrowser}</li>
          <li>{t.manual.needsServer}</li>
          <li>{t.manual.unsupported}</li>
        </ul>
        <p className="muted">{t.manual.publicNote}</p>
      </section>
    </div>
  );
}
