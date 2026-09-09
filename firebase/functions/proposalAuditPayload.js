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
  const proposal = proposalAuditPayload(record);
  return prepareProposalCommit({
    recordId: record.id,
    opportunityRecordId: record.problemId,
    expectedOpportunityRevisionIndex: 0,
    hashScheme,
    proposalPayload: proposal,
    // The whole record plus its files, mirroring the opportunity's single
    // contentHash. AuditRegistry records each hash once per proposal, and
    // attachments are frozen after submission - so a narrow
    // {methodology, attachments} slice left this hash unmoved on any other edit
    // and the amendment reverted. Both hashes now move together, and the
    // `solution` document label still keeps them distinct.
    solutionPayload: {
      ...proposal,
      attachments: [...(record.attachments ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    },
  });
}
