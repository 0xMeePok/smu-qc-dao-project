import { useEffect, useState } from "react";
import {
  countdownParts,
  expiryUrgencyLabel,
  formatCountdown,
  formatInstant,
} from "../lib/datetime.js";
import { ACCEPTANCE_WINDOW_MS, deadlineUrgency } from "../lib/deadlineUrgency.js";
import { WORKFLOW_STATUS, closedStatusLabel, opportunityStatusLabel, workflowStatusLabel } from "../config/workflowStatus.js";

/**
 * QCDAO-55 - time remaining on a posting, beside its exact UTC deadline.
 * A closed posting or confirmed match wins over the clock. Pending selections
 * count down to the creator's response deadline; reopening restores the posting deadline.
 * `windowMs` names the length of a short fixed window (for example a seven-day
 * acceptance or approval window) so its urgency is judged against that window.
 */
export function ExpiryCountdown({ expiresAt, status, matching, showInstant = true, windowMs }) {
  const [now, setNow] = useState(() => new Date());

  const matchingStatus = matching?.status;
  const pendingMatch = matchingStatus === "awaiting_confirmation" && Boolean(matching.deadlineAt);
  const deadline = pendingMatch ? matching.deadlineAt : expiresAt;
  const closedLabel = matchingStatus === "confirmed" || matchingStatus === "invalidated"
    ? opportunityStatusLabel(status, { matching })
    : closedStatusLabel(status);
  const parts = countdownParts(deadline, now);
  const expired = Boolean(closedLabel) || (parts?.expired ?? false);
  const urgency = closedLabel ? "expired" : deadlineUrgency(deadline, now, { windowMs: pendingMatch ? (windowMs ?? ACCEPTANCE_WINDOW_MS) : windowMs });
  const urgencyLabel = pendingMatch ? workflowStatusLabel(WORKFLOW_STATUS.PENDING_APPROVAL) : expiryUrgencyLabel(urgency);
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
          ? `${closedLabel}${confirmedAt ? ` at ${formatInstant(confirmedAt)}` : ""}.`
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
        ? `${workflowStatusLabel(WORKFLOW_STATUS.EXPIRED)}. ${deadlineVerb} ${formatInstant(deadline)}.`
        : `${urgencyLabel}. ${formatCountdown(deadline, now)}. ${deadlineVerb} ${formatInstant(deadline)}.`}
    >
      <strong
        aria-live="off"
        title={formatInstant(deadline)}
      >
        {expired ? workflowStatusLabel(WORKFLOW_STATUS.EXPIRED) : formatCountdown(deadline, now)}
      </strong>
      {!expired && <span className="expiry-urgency" aria-hidden="true">{urgencyLabel}</span>}
      {showInstant && <small>{formatInstant(deadline)}</small>}
    </span>
  );
}

export default ExpiryCountdown;
