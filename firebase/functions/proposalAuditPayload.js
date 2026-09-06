import { prepareProposalCommit } from "./auditCanonical.js";

// Frozen v1 field list. Changing a form label or adding a field must not change
// historical hashes. Introduce a new scheme explicitly for future payloads.
const FIELDS = [
  "researcherId", "problemId", "postingOwnerId", "opportunityType", "category", "amount", "currency",
  "title", "summary", "methodology", "suitability", "expectedOutcomes", "successCriteria",
  "timeline", "milestones", "team", "proposedProblem", "relevance", "thesisFit",
];

export function proposalAuditPayload(record) {
  return Object.fromEntries(FIELDS.map((key) => [key,
    key === "amount" ? String(record.amount ?? "") : record[key] ?? "",
  ]));
}

export function prepareStoredProposal(record) {
  const hashScheme = record.audit?.schemaVersion ?? 1;
  return prepareProposalCommit({
    recordId: record.id,
    opportunityRecordId: record.problemId,
    expectedOpportunityRevisionIndex: 0,
    hashScheme,
    proposalPayload: proposalAuditPayload(record),
    solutionPayload: {
      methodology: record.methodology ?? "",
      attachments: [...(record.attachments ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    },
  });
}
