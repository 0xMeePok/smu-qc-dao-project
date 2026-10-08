import {
  CLOSED_OPPORTUNITY_STATUSES,
  EXPIRY_REASONS,
  RESPONSE_OPEN_STATUSES,
  isExpiredOpenOpportunity,
  isResponseWindowClosed,
} from "../../../firebase/functions/opportunityExpiry.js";
import {
  opportunityWorkflowStatus,
  workflowStatusLabel,
} from "../../../firebase/functions/workflowStatus.js";

export { RESPONSE_OPEN_STATUSES, isExpiredOpenOpportunity, isResponseWindowClosed };
export * from "../../../firebase/functions/workflowStatus.js";

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

export const EXPIRY_REASON_LABELS = {
  [EXPIRY_REASONS.FUNDING_REQUIREMENT_NOT_MET]: "Funding requirement was not met",
  [EXPIRY_REASONS.EVALUATION_NOT_COMPLETED]: "Evaluation was not completed",
  [EXPIRY_REASONS.NO_SOLUTION_SELECTED]: "No solution was selected",
};

export function expiryReasonLabel(reason) {
  return EXPIRY_REASON_LABELS[String(reason ?? "")] ?? "Expiry requirements were not completed";
}

/** Badge label for an opportunity, from the shared QCDAO-91 mapping. */
export function opportunityStatusLabel(status, { expiresAt, now, matching } = {}) {
  return workflowStatusLabel(opportunityWorkflowStatus({ status, expiresAt, matching }, now));
}

/** Label for a status whose response window no longer applies, or null. */
export function closedStatusLabel(status) {
  const key = String(status ?? "").trim().toLowerCase();
  return CLOSED_OPPORTUNITY_STATUSES.has(key) ? workflowStatusLabel(opportunityWorkflowStatus({ status: key })) : null;
}

/** Escrow state values follow the contract enum; grant offer labels are separate. */
export function fundingStateLabel(state) {
  if (typeof state === "number") return ["Pending", "Locked", "Released", "Refunded", "Cancelled", "Expired", "Locked · delivery in progress", "Voided"][state] ?? "Unknown";
  return String(state ?? "Pending").replaceAll("_", " ");
}

/** Independent crowdfunding is a separate contract lifecycle from main escrow. */
export const INDEPENDENT_FUNDING_STATE = Object.freeze({ OPEN: "Open", ACCEPTED: "Accepted", RELEASED: "Released",
  DECLINED: "Declined", EXPIRED: "Expired", CANCELLED: "Cancelled", REFUNDED: "Refunded" });
export const INDEPENDENT_FUNDING_LABELS = Object.freeze({
  [INDEPENDENT_FUNDING_STATE.OPEN]: "Open for funding",
  [INDEPENDENT_FUNDING_STATE.ACCEPTED]: "Delivery in progress",
  [INDEPENDENT_FUNDING_STATE.RELEASED]: "Fully paid",
  [INDEPENDENT_FUNDING_STATE.DECLINED]: "Refunds available",
  [INDEPENDENT_FUNDING_STATE.EXPIRED]: "Refunds available",
  [INDEPENDENT_FUNDING_STATE.CANCELLED]: "Refunds available",
  [INDEPENDENT_FUNDING_STATE.REFUNDED]: "Refunded",
});
