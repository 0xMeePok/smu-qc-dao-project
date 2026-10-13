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

/** QCDAO-115: contract custody has its own vocabulary. These labels are shared
 * by posting, escrow detail and all role dashboards, outside legacy matching. */
export const MAIN_ESCROW_STATE = Object.freeze({ OPEN: "Open", LOCKED: "Locked", RELEASED: "Released", REFUNDED: "Refunded",
  CANCELLED: "Cancelled", EXPIRED: "Expired", ACTIVE: "Active", VOIDED: "Voided" });
export const MAIN_ESCROW_STATES = Object.freeze(Object.values(MAIN_ESCROW_STATE));
export const INDEPENDENT_ESCROW_STATES = Object.freeze(Object.values(INDEPENDENT_FUNDING_STATE));
export const ESCROW_LIFECYCLE_DETAILS = Object.freeze({
  [MAIN_ESCROW_STATE.OPEN]: { key: "pending", label: "Pending", meaning: "Funding is open. Contributions stay in escrow until an approved payment or an eligible refund." },
  [MAIN_ESCROW_STATE.LOCKED]: { key: "locked", label: "Locked", meaning: "The required funds are in escrow while both owners approve the upfront payment." },
  [MAIN_ESCROW_STATE.ACTIVE]: { key: "locked", label: "Locked", meaning: "The upfront payment has been released. The unpaid balance stays in escrow for completion approval or an eligible refund." },
  [INDEPENDENT_FUNDING_STATE.ACCEPTED]: { key: "locked", label: "Locked", meaning: "Accepted crowdfunding holds its unpaid balance for completion approval or an eligible refund." },
  [MAIN_ESCROW_STATE.RELEASED]: { key: "released", label: "Released", meaning: "The approved payments have been released. Released money remains paid." },
  [MAIN_ESCROW_STATE.REFUNDED]: { key: "refunded", label: "Refunded", meaning: "Eligible unpaid funds have been refunded. Any earlier payouts remain paid." },
  [MAIN_ESCROW_STATE.CANCELLED]: { key: "cancelled", label: "Cancelled", meaning: "The escrow was cancelled. Its custody status below shows when eligible unpaid refunds can be claimed." },
  [INDEPENDENT_FUNDING_STATE.DECLINED]: { key: "cancelled", label: "Cancelled", meaning: "The crowdfunding offer was declined. Eligible unpaid contributions can be refunded." },
  [MAIN_ESCROW_STATE.EXPIRED]: { key: "expired", label: "Expired", meaning: "The confirmed escrow deadline elapsed. Eligible unpaid contributions can be refunded; earlier payouts remain paid." },
  [MAIN_ESCROW_STATE.VOIDED]: { key: "invalidated", label: "Invalidated", meaning: "The escrow was invalidated. Eligible unpaid contributions can be refunded; earlier payouts remain paid." },
});
export const ESCROW_ADMIN_CANCELLATION_LABEL = "Administrator cancellation";
export const ESCROW_REFUND_REASON_LABELS = Object.freeze({
  funding_target_not_met: "The funding target was not reached before the posting closed.",
  no_proposal_selected: "No proposal was selected before the posting closed.",
  selection_approval_timeout: "The seven-day upfront approval window elapsed.",
  completion_approval_timeout: "The completion approval window elapsed; earlier payments remain paid.",
  selection_declined: "An owner declined the selection. Other eligible proposals can reopen within the original posting window.",
  cancelled: "The escrow was cancelled; its custody deadline controls when refunds can be claimed.",
  registry_invalidated: "The posting or proposal was withdrawn or another proposal was accepted.",
  escrow_voided: "The escrow was invalidated by an authorized administrator.",
  admin_cancelled: "An administrator cancelled this unpaid escrow with an anchored reason.",
  posting_expired: "The posting funding window elapsed.",
});
