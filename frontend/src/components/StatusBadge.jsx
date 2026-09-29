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
