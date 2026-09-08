import { isExpired } from "../lib/datetime.js";

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
};

export const OPPORTUNITY_STATUS_LABELS = {
  [OPPORTUNITY_STATUSES.DRAFT]: "Draft",
  [OPPORTUNITY_STATUSES.SUBMITTED]: "Submitted",
  [OPPORTUNITY_STATUSES.OPEN]: "Open",
  [OPPORTUNITY_STATUSES.IN_REVIEW]: "In review",
  [OPPORTUNITY_STATUSES.MATCHED]: "Matched",
  [OPPORTUNITY_STATUSES.FUNDED]: "Funded",
  [OPPORTUNITY_STATUSES.COMPLETED]: "Completed",
  [OPPORTUNITY_STATUSES.CANCELLED]: "Cancelled",
};

/** Statuses that still accept responses, so a passed deadline is shown as Expired. */
export const RESPONSE_OPEN_STATUSES = new Set([
  OPPORTUNITY_STATUSES.SUBMITTED,
  OPPORTUNITY_STATUSES.OPEN,
]);

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
  if (RESPONSE_OPEN_STATUSES.has(key) && isExpired(expiresAt, now)) return "Expired";
  return OPPORTUNITY_STATUS_LABELS[key] || titleStatus(status) || "Open";
}
