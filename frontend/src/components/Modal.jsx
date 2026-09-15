import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';

/**
 * Dialog shell shared by every modal.
 *
 * Rendered through a portal into <body> on purpose. Both modals are triggered from
 * controls inside the sticky header, and that header carries a `backdrop-filter`,
 * which makes it the containing block for `position: fixed` descendants. Rendered
 * in place, the backdrop sized itself to the header instead of the viewport and the
 * dialog was pushed off the top of the screen. A portal puts it outside any ancestor
 * that could capture it, whatever styling those ancestors grow later.
 */
export function Modal({ labelledBy, describedBy, onDismiss, className = "", initialFocusRef, children }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const opener = document.activeElement;
    const target = initialFocusRef?.current ?? dialogRef.current?.querySelector(FOCUSABLE) ?? dialogRef.current;
    target?.focus();
    return () => {
      // Restore keyboard context on Escape, Cancel and successful submission,
      // but do not focus a trigger removed by navigation while the dialog was open.
      if (opener?.isConnected) opener.focus?.({ preventScroll: true });
    };
  }, [initialFocusRef]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const keyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss?.();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = dialogRef.current?.querySelectorAll(FOCUSABLE);
    if (!focusable?.length) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="modal-backdrop" onKeyDown={keyDown}>
      <div
        className={`modal ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        ref={dialogRef}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
