import { createOpportunityAuditFlow } from "./opportunityAuditFlow.js";
import { commitProposalAudit, verifyProposalAudit } from "./auditRegistry.js";
import { findProposal, updateProposalReceipt } from "./proposals.js";

export { proposalAuditPayload } from "../../../firebase/functions/proposalAuditPayload.js";
import { prepareStoredProposal } from "../../../firebase/functions/proposalAuditPayload.js";
const flow = createOpportunityAuditFlow({
  entityLabel: "proposal",
  persistAudit: updateProposalReceipt,
  prepareCommit: prepareStoredProposal,
  persistConfirmed: true,
  enforceWalletRetryLimit: true,
  commitAudit: commitProposalAudit,
  verifyAudit: verifyProposalAudit,
});
export function proposalAuditReceipt(record) {
  try {
    const receipt = flow.receipt(record);
    return receipt ? { ...receipt, solutionHash: prepareStoredProposal(record).solutionHash } : null;
  } catch { return null; }
}
export const anchorProposalAudit = flow.anchor;
export async function readProposalAudit(record, options) {
  const current = await findProposal(record.id, { fromServer: true });
  if (!current) throw new Error("This proposal is no longer available or you do not have access.");
  return flow.read(current, options);
}
