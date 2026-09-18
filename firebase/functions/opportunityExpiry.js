/** Shared expiry rules for Cloud Functions and the frontend; firestore.rules mirrors the windows. */
export const EXPIRY_WINDOW_DAYS = Object.freeze([30, 60, 90, 180]);
export const DEFAULT_EXPIRY_DAYS = 90;
export const MIN_EXPIRY_DAYS = EXPIRY_WINDOW_DAYS[0];
export const MAX_EXPIRY_DAYS = EXPIRY_WINDOW_DAYS[EXPIRY_WINDOW_DAYS.length - 1];

export const EXPIRY_REASONS = Object.freeze({
  FUNDING_REQUIREMENT_NOT_MET: "funding_requirement_not_met",
  EVALUATION_NOT_COMPLETED: "evaluation_not_completed",
  NO_SOLUTION_SELECTED: "no_solution_selected",
});

export const EXPIRY_REASON_LABELS = Object.freeze({
  [EXPIRY_REASONS.FUNDING_REQUIREMENT_NOT_MET]: "Funding requirement not met",
  [EXPIRY_REASONS.EVALUATION_NOT_COMPLETED]: "Evaluation not completed",
  [EXPIRY_REASONS.NO_SOLUTION_SELECTED]: "No solution selected",
});

/** Statuses that still accept responses. */
export const RESPONSE_OPEN_STATUSES = new Set(["submitted", "open"]);
/** Statuses after which the response window no longer applies. */
export const CLOSED_OPPORTUNITY_STATUSES = new Set(["expired", "cancelled", "completed"]);

export const COUNTED_FUNDING_STATUSES = Object.freeze(["pledged", "approved", "disbursing", "completed"]);
export const PENDING_PROPOSAL_STATUSES = Object.freeze(["submitted", "under_review"]);

const DAY_MS = 24 * 60 * 60 * 1000;

function statusOf(record) {
  return String(record?.status ?? "").trim().toLowerCase();
}

function nonNegativeAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : 0;
}

/** Epoch milliseconds for a Timestamp, Date, number or date string; NaN when unusable. */
export function instantMs(value) {
  if (value === null || value === undefined) return Number.NaN;
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  try {
    return (value instanceof Date ? value : new Date(value)).getTime();
  } catch {
    return Number.NaN;
  }
}

export function isExpiryWindow(days) {
  return EXPIRY_WINDOW_DAYS.includes(Number(days));
}

/** A deadline `days` after `from`, to the whole second. */
export function expiryFrom(days, from = new Date()) {
  const expiry = new Date(instantMs(from) + Number(days) * DAY_MS);
  expiry.setUTCMilliseconds(0);
  return expiry;
}

/** Adds a documented window exactly, which is what firestore.rules compares. */
export function extendExpiry(expiresAt, days) {
  const current = instantMs(expiresAt);
  if (!Number.isFinite(current) || !isExpiryWindow(days)) return null;
  return new Date(current + Number(days) * DAY_MS);
}

/** The one boundary: a deadline has passed at its exact instant, as in the contract and rules. */
export function deadlinePassed(expiresAt, now = new Date()) {
  const deadline = instantMs(expiresAt);
  const current = instantMs(now);
  return Number.isFinite(deadline) && Number.isFinite(current) && deadline <= current;
}

/** Due to lapse, and locked to its owner by firestore.rules. */
export function isExpiredOpenOpportunity(opportunity, now = new Date()) {
  return RESPONSE_OPEN_STATUSES.has(statusOf(opportunity)) && deadlinePassed(opportunity?.expiresAt, now);
}

/** No time left to act: a terminal status, or the deadline has passed. */
export function isResponseWindowClosed(opportunity, now = new Date()) {
  return CLOSED_OPPORTUNITY_STATUSES.has(statusOf(opportunity)) || deadlinePassed(opportunity?.expiresAt, now);
}

/** Sum live funding commitments. */
export function countedFundingAmount(records = []) {
  if (!Array.isArray(records)) return 0;
  return records.reduce((total, record) => (
    total + (COUNTED_FUNDING_STATUSES.includes(statusOf(record))
      ? nonNegativeAmount(record?.amount)
      : 0)
  ), 0);
}

function hasSelectedSolution(opportunity) {
  return Boolean(
    String(opportunity?.acceptedProposalId ?? "").trim()
    || String(opportunity?.acceptedSolutionId ?? "").trim()
    || opportunity?.hasAcceptedSolution === true
  );
}

/** Mock matches own their funding/confirmation deadlines and refund settlement. */
export function hasMockMatchingLifecycle(opportunity) {
  return opportunity?.matching?.mode === "mock";
}

/** First applicable reason from summarised facts, so callers never load every related record. */
export function expiryReasonFromFacts({
  opportunity,
  fundedAmount = 0,
  hasPendingProposal = false,
  hasUnacceptedEvaluation = false,
  now = new Date(),
} = {}) {
  if (!isExpiredOpenOpportunity(opportunity, now)) return null;
  // Mock expiry uses matching.js to atomically invalidate and refund its ledger;
  // the legacy opportunity sweep must not bypass that settlement.
  if (hasMockMatchingLifecycle(opportunity)) return null;
  if (nonNegativeAmount(fundedAmount) < nonNegativeAmount(opportunity?.amount)) {
    return EXPIRY_REASONS.FUNDING_REQUIREMENT_NOT_MET;
  }
  if (hasPendingProposal || hasUnacceptedEvaluation) return EXPIRY_REASONS.EVALUATION_NOT_COMPLETED;
  if (!hasSelectedSolution(opportunity)) return EXPIRY_REASONS.NO_SOLUTION_SELECTED;
  return null;
}

/** Return the first applicable expiry reason. */
export function expiryReason({
  opportunity,
  funding = [],
  proposals = [],
  evaluations = [],
  now,
} = {}) {
  return expiryReasonFromFacts({
    opportunity,
    now,
    fundedAmount: countedFundingAmount(funding),
    hasPendingProposal: Array.isArray(proposals) && proposals.some((proposal) => (
      proposal && PENDING_PROPOSAL_STATUSES.includes(statusOf(proposal))
    )),
    hasUnacceptedEvaluation: Array.isArray(evaluations) && evaluations.some((evaluation) => (
      evaluation && statusOf(evaluation) !== "accepted"
    )),
  });
}
