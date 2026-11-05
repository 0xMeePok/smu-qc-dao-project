import { validReviewedParentAudit } from "./publicationValidation.js";

export const ATTACHED_SCHEMA_VALIDATION = "attached-proposal-schema-v1";
const KEYS = new Set([
  "researcherId", "problemId", "title", "summary", "amount", "status",
  "postingOwnerId", "opportunityType", "category", "currency", "attachments",
  "methodology", "suitability", "expectedOutcomes", "successCriteria",
  "timeline", "milestones", "team", "proposedProblem", "relevance", "thesisFit",
  "withdrawalReason", "fundingPlan", "fundingTerms", "aiAssisted", "reviewedParentAudit",
]);

// Only the key allowlist and optional metadata shape move behind this marker.
// All content bounds, PDFs, receipts and synchronous parent/slot/lock checks
// remain in firestore.rules. The proof excludes id/audit/timestamps separately.
export function hasAttachedPublicationSchema(record) {
  return Boolean(record) && typeof record === "object" && !Array.isArray(record)
    && Object.keys(record).every(key => KEYS.has(key))
    && (!Object.hasOwn(record, "aiAssisted") || typeof record.aiAssisted === "boolean")
    && (!Object.hasOwn(record, "reviewedParentAudit") || validReviewedParentAudit(record.reviewedParentAudit));
}
