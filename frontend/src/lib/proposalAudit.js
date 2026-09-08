import { configuredAuditRegistryAddress, createOpportunityAuditFlow } from "./opportunityAuditFlow.js";
import { commitProposalAudit, prepareProposalWithdrawal, readProposalIsAnchored, updateProposalAudit, verifyProposalAudit, withdrawProposalAudit } from "./auditRegistry.js";
import { findProposal, updateProposalReceipt } from "./proposals.js";

export { proposalAuditPayload } from "../../../firebase/functions/proposalAuditPayload.js";
import { prepareStoredProposal } from "../../../firebase/functions/proposalAuditPayload.js";
import { asProposalUpdate } from "../../../firebase/functions/auditCanonical.js";

async function anchorProposal(prepared, options) {
  return await readProposalIsAnchored(prepared.entityId, options)
    ? updateProposalAudit(asProposalUpdate(prepared), options)
    : commitProposalAudit(prepared, options);
}

const flow = createOpportunityAuditFlow({
  entityLabel: "proposal",
  persistAudit: updateProposalReceipt,
  prepareCommit: prepareStoredProposal,
  persistConfirmed: true,
  enforceWalletRetryLimit: true,
  commitAudit: anchorProposal,
  verifyAudit: verifyProposalAudit,
});
export function proposalAuditReceipt(record) {
  try {
    const receipt = flow.receipt(record);
    return receipt ? { ...receipt, solutionHash: prepareStoredProposal(record).solutionHash } : null;
  } catch { return null; }
}
export const anchorProposalAudit = flow.anchor;

export function anchorProposalBeforeWrite(record, options = {}) {
  return flow.anchor(record, { ...options, persistReceipt: false });
}

/**
 * The receipt as it may be stored by a client. `confirmed` is a server
 * attestation - firestore.rules rejects it from a browser - so a transaction
 * this client just watched being mined is written as `pending` carrying its real
 * hash, and confirmProposalAudit promotes it. The queued audit job means the
 * server still promotes it even if this tab closes first.
 */
export function receiptForWrite(audit) {
  return audit && audit.status === "confirmed" ? { ...audit, status: "pending" } : audit;
}

export async function anchorProposalWithdrawal(record, { account, adapters, reason, onStatus } = {}) {
  const address = configuredAuditRegistryAddress();
  if (!address) throw new Error("AuditRegistry is not configured.");
  return withdrawProposalAudit(
    prepareProposalWithdrawal({
      recordId: record.id, researcherId: record.researcherId, reason,
    }),
    { address, account, adapters, onStatus },
  );
}
export async function readProposalAudit(record, options) {
  const current = await findProposal(record.id, { fromServer: true });
  if (!current) throw new Error("This proposal is no longer available or you do not have access.");
  return flow.read(current, options);
}
