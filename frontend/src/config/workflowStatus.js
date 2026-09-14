import {
  CLOSED_OPPORTUNITY_STATUSES,
  EXPIRY_REASONS,
  RESPONSE_OPEN_STATUSES,
  deadlinePassed,
  isExpiredOpenOpportunity,
  isResponseWindowClosed,
} from "../../../firebase/functions/opportunityExpiry.js";

export { RESPONSE_OPEN_STATUSES, isExpiredOpenOpportunity, isResponseWindowClosed };

/**
 * Opportunity workflow statuses stored on `problems/{id}.status`.
 * Keep in lockstep with firebase/firestore.rules `validProblemStatus`.
 */
export const OPPORTUNITY_STATUSES = {
  DRAFT: "draft",
  SUBMITTED: "submitted",
  OPEN: "open",
  IN_REVIEW: "in_review",
  MATCHED: "matched",
  FUNDED: "funded",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
};

export const OPPORTUNITY_STATUS_LABELS = {
  [OPPORTUNITY_STATUSES.DRAFT]: "Draft",
  [OPPORTUNITY_STATUSES.SUBMITTED]: "Submitted",
  [OPPORTUNITY_STATUSES.OPEN]: "Open",
  [OPPORTUNITY_STATUSES.IN_REVIEW]: "In review",
  [OPPORTUNITY_STATUSES.MATCHED]: "Matched",
  [OPPORTUNITY_STATUSES.FUNDED]: "Funded",
  [OPPORTUNITY_STATUSES.COMPLETED]: "Completed",
  // The stored status stays `cancelled`; the word users act on is "withdraw".
  [OPPORTUNITY_STATUSES.CANCELLED]: "Withdrawn",
  [OPPORTUNITY_STATUSES.EXPIRED]: "Expired",
};

export const EXPIRY_REASON_LABELS = {
  [EXPIRY_REASONS.FUNDING_REQUIREMENT_NOT_MET]: "Funding requirement was not met",
  [EXPIRY_REASONS.EVALUATION_NOT_COMPLETED]: "Evaluation was not completed",
  [EXPIRY_REASONS.NO_SOLUTION_SELECTED]: "No solution was selected",
};

export function expiryReasonLabel(reason) {
  return EXPIRY_REASON_LABELS[String(reason ?? "")] ?? "Expiry requirements were not completed";
}

function titleStatus(status) {
  return String(status ?? "")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

/**
 * Human label for an opportunity badge. A passed expiry overlays "Expired" only
 * while the posting is still in a response-open state, so funded or cancelled
 * work is not relabelled after the original window closes.
 */
export function opportunityStatusLabel(status, { expiresAt, now } = {}) {
  const key = String(status ?? "").trim().toLowerCase();
  if (RESPONSE_OPEN_STATUSES.has(key) && deadlinePassed(expiresAt, now)) return "Expired";
  return OPPORTUNITY_STATUS_LABELS[key] || titleStatus(status) || "Open";
}

/** Label for a status whose response window no longer applies, or null. */
export function closedStatusLabel(status) {
  const key = String(status ?? "").trim().toLowerCase();
  return CLOSED_OPPORTUNITY_STATUSES.has(key) ? OPPORTUNITY_STATUS_LABELS[key] : null;
}
