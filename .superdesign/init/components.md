# Shared UI primitives

React 18 + Vite. No component library. Styling is one global stylesheet, `frontend/src/styles.css`. Buttons, inputs, and cards are CSS classes (`.primary`, `.secondary`, `.card-table`, `.field`), not React components.

## Modal

- Path: `frontend/src/components/Modal.jsx`
- Dialog shell with focus trap, Escape dismiss, and body scroll lock.
- Props: labelledBy, describedBy, onDismiss, className, initialFocusRef, children

```jsx
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
```

## Field

- Path: `frontend/src/components/Field.jsx`
- Label, hint, and error wrapper that wires aria-describedby and aria-invalid.
- Props: label, htmlFor, error, hint, children

```jsx
export function Field({ label, htmlFor, error, hint, children }) {
  const errorId = error ? `${htmlFor}-error` : undefined;
  const hintId = hint ? `${htmlFor}-hint` : undefined;

  return (
    <div className={`field${error ? " field-invalid" : ""}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children({
        id: htmlFor,
        describedBy: [hintId, errorId].filter(Boolean).join(" ") || undefined,
        invalid: Boolean(error),
      })}
      {hint ? <p className="field-hint" id={hintId}>{hint}</p> : null}
      {error ? <p className="field-error" id={errorId} role="alert">{error}</p> : null}
    </div>
  );
}
```

## StatusBadge

- Path: `frontend/src/components/StatusBadge.jsx`
- Workflow status pill.
- Props: status

```jsx
import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  WORKFLOW_STATUS_DETAILS,
  evaluationSummary,
  workflowStatusDetails,
} from "../config/workflowStatus.js";

// One glyph per icon name in WORKFLOW_STATUS_DETAILS, so no status is colour-only.
export const STATUS_ICON_PATHS = {
  draft: ["M10.8 2.7l2.5 2.5-7.6 7.6-3.1.6.6-3.1z", "M9.3 4.2l2.5 2.5"],
  submitted: ["M2.5 7.6 13.5 2.5 9.9 13.5 7.8 8.6z", "M7.8 8.6 13.5 2.5"],
  hourglass: ["M4.5 2.5h7M4.5 13.5h7", "M5.25 2.5c0 3 5.5 3.6 5.5 5.5s-5.5 2.5-5.5 5.5", "M10.75 2.5c0 3-5.5 3.6-5.5 5.5s5.5 2.5 5.5 5.5"],
  selected: ["M8 2.2l1.75 3.6 3.95.55-2.85 2.8.7 3.95L8 11.2l-3.55 1.9.7-3.95L2.3 6.35l3.95-.55z"],
  clock: ["M8 2.6a5.4 5.4 0 1 0 0 10.8A5.4 5.4 0 0 0 8 2.6z", "M8 5.1V8l2.15 1.35"],
  check: ["M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 2.4z", "M5.4 8.1l1.8 1.8 3.4-3.6"],
  record: ["M4 1.9h5.3L12 4.6v9.5H4z", "M9.3 1.9v2.7H12", "M6 9.1l1.4 1.4 2.6-2.8"],
  invalid: ["M5.4 2.25h5.2L13.75 5.4v5.2L10.6 13.75H5.4L2.25 10.6V5.4z", "m6 6 4 4M10 6l-4 4"],
  declined: ["M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 2.4z", "M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2"],
  expired: ["M2.75 3.75h10.5v9.5H2.75z", "M2.75 6.5h10.5M5.5 2.25v3M10.5 2.25v3", "M6.4 8.6l3.2 3.2M9.6 8.6l-3.2 3.2"],
  refunded: ["M5.5 4.25 2.75 7l2.75 2.75", "M2.75 7h6.5a3.25 3.25 0 0 1 0 6.5H7.5"],
  "thumbs-up": ["M5.25 7.25v6.25h-2.5V7.25z", "M5.25 7.25 7.9 2.5c.95 0 1.6.75 1.45 1.7L9 6.25h3.35c.85 0 1.45.8 1.25 1.6l-1.1 4.4c-.15.7-.8 1.25-1.5 1.25H5.25"],
  "thumbs-down": ["M5.25 8.75V2.5h-2.5v6.25z", "M5.25 8.75 7.9 13.5c.95 0 1.6-.75 1.45-1.7L9 9.75h3.35c.85 0 1.45-.8 1.25-1.6l-1.1-4.4c-.15-.7-.8-1.25-1.5-1.25H5.25"],
  revise: ["M2.5 13.5h11", "M9.8 2.9l2.3 2.3-6.4 6.4-2.9.6.6-2.9z"],
};

export function StatusIcon({ name }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      {(STATUS_ICON_PATHS[name] ?? []).map((path) => <path key={path} d={path} />)}
    </svg>
  );
}

/** QCDAO-91. Every workflow status renders here, with a meaning-and-next tooltip.
 * `interactive={false}` renders a plain span; `summary` is a combined evaluationSummary. */
export function StatusBadge({ status, count = 0, prefix = "", interactive = true, className = "", summary = null }) {
  const tooltipId = useId();
  const wrapRef = useRef(null);
  const tooltipRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const details = workflowStatusDetails(status);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const trigger = wrapRef.current?.getBoundingClientRect();
      const tip = tooltipRef.current?.getBoundingClientRect();
      if (!trigger || !tip) return;
      const margin = 8;
      let top = trigger.top - tip.height - 6;
      if (top < margin) top = trigger.bottom + 6;
      const left = Math.max(margin, Math.min(trigger.left, window.innerWidth - tip.width - margin));
      setCoords({ top, left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  if (!details) return null;
  const label = summary?.text ?? `${prefix}${details.label}${count > 1 ? ` ×${count}` : ""}`;
  const icons = summary?.icons ?? [details.icon];
  const Tag = interactive ? "button" : "span";
  const dismiss = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.blur();
    setOpen(false);
  };

  return (
    <span
      ref={wrapRef}
      className={`workflow-badge-wrap${className ? ` ${className}` : ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <Tag
        {...(interactive ? { type: "button", onClick: (event) => event.stopPropagation(), onKeyDown: dismiss,
          onFocus: () => setOpen(true), onBlur: () => setOpen(false) } : {})}
        className={`workflow-badge tone-${summary?.tone ?? details.tone}`}
        data-status={String(status).toLowerCase()}
        aria-describedby={tooltipId}
      >
        {icons.map((icon, index) => <StatusIcon key={`${icon}-${index}`} name={icon} />)}
        <span className="workflow-badge-label">{label}</span>
      </Tag>
      {typeof document !== "undefined" && createPortal(
        <span
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          className={`workflow-badge-tooltip${open ? " is-open" : ""}`}
          style={{ top: coords.top, left: coords.left }}
        >
          {summary
            ? <><strong>{summary.text}:</strong> {summary.breakdown}. <em>Next:</em> {details.next}</>
            : <><strong>{details.label}.</strong> {details.description} <em>Next:</em> {details.next}</>}
        </span>,
        document.body,
      )}
    </span>
  );
}

/** Awaiting evaluator feedback, the single outcome, or one combined badge for several evaluations. */
export function EvaluationBadges({ counts = {}, interactive = true }) {
  const summary = evaluationSummary(counts);
  if (summary.total > 1) return <StatusBadge status={summary.status} summary={summary} interactive={interactive} />;
  return <StatusBadge status={summary.status} prefix={summary.total ? "Evaluator · " : ""} interactive={interactive} />;
}

/** QCDAO-91 reference legend: every status, its meaning and what happens next. */
export function StatusLegend() {
  return (
    <dl className="status-legend">
      {Object.keys(WORKFLOW_STATUS_DETAILS).map((status) => (
        <div key={status}>
          <dt><StatusBadge status={status} interactive={false} /></dt>
          <dd>{WORKFLOW_STATUS_DETAILS[status].description} <em>Next:</em> {WORKFLOW_STATUS_DETAILS[status].next}</dd>
        </div>
      ))}
    </dl>
  );
}
```

## VerifiedBadge

- Path: `frontend/src/components/VerifiedBadge.jsx`
- On-chain verification chip.
- Props: state

```jsx
import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  VERIFIED_BADGE_COPY,
  VERIFIED_BADGE_HINT,
  VERIFIED_STATES,
  verifiedStateFromAudit,
} from "../config/verifiedBadge.js";

function ShieldIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.75 3.25 3.6v4.15c0 3.05 1.95 4.95 4.75 6.5 2.8-1.55 4.75-3.45 4.75-6.5V3.6Z" />
      <path d="M5.6 8.05 7.2 9.6l3.2-3.35" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.4" />
      <path d="M8 5.1V8l2.15 1.35" />
    </svg>
  );
}

function OctagonIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.4 2.25h5.2L13.75 5.4v5.2L10.6 13.75H5.4L2.25 10.6V5.4Z" />
      <path d="m6 6 4 4M10 6l-4 4" />
    </svg>
  );
}

function UnlinkedIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.35 9.55 4.9 11a2.15 2.15 0 1 1-3.05-3.05L3.3 6.5" />
      <path d="M9.65 6.45 11.1 5a2.15 2.15 0 1 1 3.05 3.05L12.7 9.5" />
    </svg>
  );
}

const STATE_ICONS = {
  [VERIFIED_STATES.VERIFIED]: ShieldIcon,
  [VERIFIED_STATES.PENDING]: ClockIcon,
  [VERIFIED_STATES.FAILED]: OctagonIcon,
  [VERIFIED_STATES.NOT_ANCHORED]: UnlinkedIcon,
};

/**
 * Compact verification indicator. Pass a stored audit receipt, or an explicit
 * state when the caller has already mapped it. Hover, focus, or tap reveals
 * what was anchored versus what stays off-chain; Escape dismisses it. Browsing
 * views may hide the ambiguous Pending chip while retaining receipt details.
 */
export function VerifiedBadge({ audit, recordStatus, state, className = "", hidePending = false }) {
  const tooltipId = useId();
  const wrapRef = useRef(null);
  const tooltipRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const resolved = VERIFIED_BADGE_COPY[state]
    ? state
    : verifiedStateFromAudit(audit, { recordStatus });
  const copy = VERIFIED_BADGE_COPY[resolved];
  const Icon = STATE_ICONS[resolved];
  const hidden = hidePending && resolved === VERIFIED_STATES.PENDING;

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const trigger = wrapRef.current;
      const tooltip = tooltipRef.current;
      if (!trigger || !tooltip) return;
      const rect = trigger.getBoundingClientRect();
      const tip = tooltip.getBoundingClientRect();
      const gap = 6;
      const margin = 8;
      let top = rect.top - tip.height - gap;
      let left = rect.left;
      if (top < margin) top = rect.bottom + gap;
      if (left + tip.width > window.innerWidth - margin) {
        left = window.innerWidth - tip.width - margin;
      }
      if (left < margin) left = margin;
      setCoords({ top, left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const dismissOnEscape = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.blur();
    setOpen(false);
  };

  const keepParentFromActivating = (event) => {
    event.stopPropagation();
  };

  if (hidden) return null;

  return (
    <span
      ref={wrapRef}
      className={`verified-badge-wrap${className ? ` ${className}` : ""}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={`verified-badge verified-badge-${resolved}`}
        aria-label={copy.ariaLabel}
        aria-describedby={tooltipId}
        onKeyDown={dismissOnEscape}
        onClick={keepParentFromActivating}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <Icon />
        <span className="verified-badge-label">{copy.label}</span>
      </button>
      {createPortal(
        <span
          ref={tooltipRef}
          className={`verified-badge-tooltip${open ? " is-open" : ""}`}
          id={tooltipId}
          role="tooltip"
          style={{ top: coords.top, left: coords.left }}
        >
          {VERIFIED_BADGE_HINT}
        </span>,
        document.body,
      )}
    </span>
  );
}
```

