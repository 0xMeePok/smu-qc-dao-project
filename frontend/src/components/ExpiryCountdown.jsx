import { useEffect, useState } from "react";
import {
  countdownParts,
  expiryUrgency,
  expiryUrgencyLabel,
  formatCountdown,
  formatInstant,
} from "../lib/datetime.js";
import { closedStatusLabel } from "../config/workflowStatus.js";

/**
 * QCDAO-55 - time remaining on a posting, beside its exact UTC deadline.
 * A closed status wins over the clock, so a force-expired or withdrawn posting never counts down.
 */
export function ExpiryCountdown({ expiresAt, status, showInstant = true }) {
  const [now, setNow] = useState(() => new Date());

  const closedLabel = closedStatusLabel(status);
  const parts = countdownParts(expiresAt, now);
  const expired = Boolean(closedLabel) || (parts?.expired ?? false);
  const urgency = closedLabel ? "expired" : expiryUrgency(expiresAt, now);

  useEffect(() => {
    if (!expiresAt || expired) return undefined;
    const timer = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(timer);
  }, [expiresAt, expired]);

  if (closedLabel) {
    return (
      <span
        className="expiry-countdown expiry-expired"
        aria-label={`${closedLabel}. Deadline ${formatInstant(expiresAt)}.`}
      >
        <strong aria-live="off" title={formatInstant(expiresAt)}>{closedLabel}</strong>
        {showInstant && <small>{formatInstant(expiresAt)}</small>}
      </span>
    );
  }

  if (!parts) return <span className="expiry-countdown" aria-label="Deadline unavailable">—</span>;

  return (
    <span
      className={`expiry-countdown expiry-${urgency}`}
      aria-label={expired
        ? `Expired. Closes ${formatInstant(expiresAt)}.`
        : `${expiryUrgencyLabel(urgency)}. ${formatCountdown(expiresAt, now)}. Closes ${formatInstant(expiresAt)}.`}
    >
      <strong
        aria-live="off"
        title={formatInstant(expiresAt)}
      >
        {expired ? "Expired" : formatCountdown(expiresAt, now)}
      </strong>
      {!expired && <span className="expiry-urgency" aria-hidden="true">{expiryUrgencyLabel(urgency)}</span>}
      {showInstant && <small>{formatInstant(expiresAt)}</small>}
    </span>
  );
}

export default ExpiryCountdown;
