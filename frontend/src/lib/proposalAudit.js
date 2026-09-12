import { configuredAuditRegistryAddress, createOpportunityAuditFlow } from "./opportunityAuditFlow.js";
import { commitProposalAudit, prepareProposalWithdrawal, readOpportunityRevisionIndex, readProposalHashes, readProposalIsAnchored, updateProposalAudit, verifyProposalAudit, withdrawProposalAudit } from "./auditRegistry.js";
import { findProposal, updateProposalReceipt } from "./proposals.js";

export { proposalAuditPayload } from "../../../firebase/functions/proposalAuditPayload.js";
import { prepareStoredProposal } from "../../../firebase/functions/proposalAuditPayload.js";
import { asProposalUpdate, withOpportunityRevisionIndex } from "../../../firebase/functions/auditCanonical.js";

async function anchorProposal(prepared, options) {
  let operation = prepared;
  try {
    operation = withOpportunityRevisionIndex(
      prepared,
      await readOpportunityRevisionIndex(prepared.opportunityId, options),
    );
  } catch {
    // Missing parent: commitProposal / updateHashes will revert with a mapped error.
  }
  if (!await readProposalIsAnchored(operation.entityId, options)) {
    return commitProposalAudit(operation, options);
  }
  await assertAmendmentIsNew(operation, options);
  return updateProposalAudit(asProposalUpdate(operation), options);
}

/**
 * Mirrors writeOpportunityAudit: compare against what is stored BEFORE the wallet
 * opens. AuditRegistry records each REVISION once, so only a write that moves
 * neither hash is refused - and it reverted as a bare InvalidInput after the
 * author had already confirmed the transaction.
 */
async function assertAmendmentIsNew(operation, options) {
  const stored = await readProposalHashes(operation.entityId, options);
  if (stored.matches(stored.proposalHash, operation.proposalHash)
    && stored.matches(stored.solutionHash, operation.solutionHash)) {
    throw new Error(
      "This proposal is already anchored on Arbitrum Sepolia exactly as it stands. "
      + "Change something before signing again.",
    );
  }
}

const flow = createOpportunityAuditFlow({
  entityLabel: "proposal",
  persistAudit: updateProposalReceipt,
  prepareCommit: prepareStoredProposal,
  loadRecord: findProposal,
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
export const readProposalAudit = flow.read;
