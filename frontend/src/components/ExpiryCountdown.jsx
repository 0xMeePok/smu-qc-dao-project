import { useEffect, useState } from "react";
import {
  countdownParts,
  expiryUrgency,
  expiryUrgencyLabel,
  formatCountdown,
  formatInstant,
} from "../lib/datetime.js";
import { closedStatusLabel, opportunityStatusLabel } from "../config/workflowStatus.js";

/**
 * QCDAO-55 - time remaining on a posting, beside its exact UTC deadline.
 * A closed posting or confirmed match wins over the clock. Pending selections
 * count down to the creator's response deadline; reopening restores the posting deadline.
 */
export function ExpiryCountdown({ expiresAt, status, matching, showInstant = true }) {
  const [now, setNow] = useState(() => new Date());

  const matchingStatus = matching?.status;
  const pendingMatch = matchingStatus === "awaiting_confirmation" && Boolean(matching.deadlineAt);
  const deadline = pendingMatch ? matching.deadlineAt : expiresAt;
  const closedLabel = matchingStatus === "confirmed" || matchingStatus === "invalidated"
    ? opportunityStatusLabel(status, { matching })
    : closedStatusLabel(status);
  const parts = countdownParts(deadline, now);
  const expired = Boolean(closedLabel) || (parts?.expired ?? false);
  const urgency = closedLabel ? "expired" : expiryUrgency(deadline, now);
  const urgencyLabel = pendingMatch ? "Awaiting creator acceptance" : expiryUrgencyLabel(urgency);
  const deadlineVerb = pendingMatch ? "Creator response ends" : "Closes";
  const confirmedAt = matchingStatus === "confirmed" ? matching.confirmedAt : null;

  useEffect(() => {
    if (!deadline || expired) return undefined;
    const timer = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(timer);
  }, [deadline, expired]);

  if (closedLabel) {
    return (
      <span
        className={`expiry-countdown ${matchingStatus === "confirmed" ? "expiry-confirmed" : "expiry-expired"}`}
        aria-label={matchingStatus === "confirmed"
          ? `Match confirmed${confirmedAt ? ` at ${formatInstant(confirmedAt)}` : ""}.`
          : `${closedLabel}. Deadline ${formatInstant(expiresAt)}.`}
      >
        <strong aria-live="off" title={matchingStatus === "confirmed"
          ? (confirmedAt ? formatInstant(confirmedAt) : undefined)
          : formatInstant(expiresAt)}>{closedLabel}</strong>
        {showInstant && matchingStatus === "confirmed" && confirmedAt ? <small>{formatInstant(confirmedAt)}</small> : null}
        {showInstant && matchingStatus !== "confirmed" ? <small>{formatInstant(expiresAt)}</small> : null}
      </span>
    );
  }

  if (!parts) return <span className="expiry-countdown" aria-label="Deadline unavailable">—</span>;

  return (
    <span
      className={`expiry-countdown expiry-${urgency}`}
      aria-label={expired
        ? `Expired. ${deadlineVerb} ${formatInstant(deadline)}.`
        : `${urgencyLabel}. ${formatCountdown(deadline, now)}. ${deadlineVerb} ${formatInstant(deadline)}.`}
    >
      <strong
        aria-live="off"
        title={formatInstant(deadline)}
      >
        {expired ? "Expired" : formatCountdown(deadline, now)}
      </strong>
      {!expired && <span className="expiry-urgency" aria-hidden="true">{urgencyLabel}</span>}
      {showInstant && <small>{formatInstant(deadline)}</small>}
    </span>
  );
}

export default ExpiryCountdown;
