import { createOpportunityAuditFlow } from "./opportunityAuditFlow.js";
import { prepareProposalCommit, commitProposalAudit, verifyProposalAudit } from "./auditRegistry.js";
import { updateProposalReceipt } from "./proposals.js";
import { PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS } from "../config/proposal.js";

export function proposalAuditPayload(record) {
  return Object.fromEntries([
    "researcherId", "problemId", "postingOwnerId", "opportunityType", "category", "amount", "currency",
    ...PROPOSAL_FIELDS.map(([key]) => key), ...PROBLEM_FRAMING_FIELDS.map(([key]) => key),
  ].map((key) => [key, key === "amount" ? String(record.amount ?? "") : record[key] ?? ""]));
}
const flow = createOpportunityAuditFlow({
  entityLabel: "proposal",
  persistAudit: updateProposalReceipt,
  prepareCommit: (record) => prepareProposalCommit({
    recordId: record.id,
    opportunityRecordId: record.problemId,
    // Posting publication currently creates the initial immutable revision.
    expectedOpportunityRevisionIndex: 0,
    proposalPayload: proposalAuditPayload(record),
    solutionPayload: { methodology: record.methodology ?? "", attachments: [...(record.attachments ?? [])].sort((a, b) => a.id.localeCompare(b.id)) },
  }),
  commitAudit: commitProposalAudit,
  verifyAudit: verifyProposalAudit,
});
export const proposalAuditReceipt = flow.receipt;
export const anchorProposalAudit = flow.anchor;
export const readProposalAudit = flow.read;
