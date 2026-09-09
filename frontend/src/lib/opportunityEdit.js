import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";

/** Live marketplace statuses a sponsor may still correct. */
export const EDITABLE_OPPORTUNITY_STATUSES = ["submitted", "open"];

/**
 * Fields that change the ask researchers already responded to. Locked once the
 * first proposal has been received; attachments stay editable as supporting
 * material that does not rewrite the funded problem or funding thesis.
 */
export const MATERIAL_POSTING_FIELDS = [
  "title", "summary", "businessContext", "currentApproach", "currentLimitations",
  "expectedOutcome", "successCriteria", "dataAvailability",
  "categories", "amount", "currency", "expiresAt",
];

export const MATERIAL_FUNDING_FIELDS = [
  "title", "fundingThesis", "eligibilityNotes",
  "categories", "tags", "amount", "currency", "expiresAt",
];

export const NON_MATERIAL_OPPORTUNITY_FIELDS = ["attachments"];

export function opportunityHasProposals(posting) {
  return Number(posting?.proposalCount ?? 0) > 0;
}

export function materialFieldsLocked(posting) {
  return opportunityHasProposals(posting);
}

export function canEditOpportunity(posting, userId) {
  if (!posting || !userId) return false;
  if (String(posting.ownerId).toLowerCase() !== String(userId).toLowerCase()) return false;
  return EDITABLE_OPPORTUNITY_STATUSES.includes(posting.status);
}

export function materialFieldKeys(posting) {
  return posting?.opportunityType === OPEN_FUNDING_TYPE
    ? MATERIAL_FUNDING_FIELDS
    : MATERIAL_POSTING_FIELDS;
}
