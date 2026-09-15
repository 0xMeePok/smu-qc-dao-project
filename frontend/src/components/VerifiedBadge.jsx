import { useId } from "react";
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
 * what was anchored versus what stays off-chain; Escape dismisses it.
 */
export function VerifiedBadge({ audit, recordStatus, state, className = "" }) {
  const tooltipId = useId();
  const resolved = VERIFIED_BADGE_COPY[state]
    ? state
    : verifiedStateFromAudit(audit, { recordStatus });
  const copy = VERIFIED_BADGE_COPY[resolved];
  const Icon = STATE_ICONS[resolved];

  const dismissOnEscape = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.blur();
  };

  const keepParentFromActivating = (event) => {
    event.stopPropagation();
  };

  return (
    <span className={`verified-badge-wrap${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className={`verified-badge verified-badge-${resolved}`}
        aria-label={copy.ariaLabel}
        aria-describedby={tooltipId}
        onKeyDown={dismissOnEscape}
        onClick={keepParentFromActivating}
      >
        <Icon />
        <span className="verified-badge-label">{copy.label}</span>
      </button>
      <span className="verified-badge-tooltip" id={tooltipId} role="tooltip">
        {VERIFIED_BADGE_HINT}
      </span>
    </span>
  );
}
