import { AUDIT_ENTITY_ID_SCHEME } from "../config/auditRegistry.js";
import { assertCurrentAuditRecord, configuredAuditRegistryAddress, createOpportunityAuditFlow } from "./opportunityAuditFlow.js";
import {
  commitProposalAudit, prepareProposalWithdrawal, readOpportunityRevisionIndex, readProposalHashes,
  readProposalIsAnchored, updateProposalAudit, verifyProposalAudit, withdrawProposalAudit,
  writeOpportunityAudit,
} from "./auditRegistry.js";
import { findProposal, updateProposalReceipt } from "./proposals.js";
import { isIndependentProposal } from "../../../firebase/functions/independentProposal.js";

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
  verifyAudit: (prepared, options) => verifyProposalAudit(prepared, {
    ...options,
    useRecordedOpportunityRevision: true,
  }),
});

const independentFlow = createOpportunityAuditFlow({
  entityLabel: "proposal",
  persistAudit: updateProposalReceipt,
  prepareCommit: prepareStoredProposal,
  loadRecord: findProposal,
  persistConfirmed: true,
  enforceWalletRetryLimit: true,
  commitAudit: writeOpportunityAudit,
});

export function proposalAuditReceipt(record) {
  try {
    const active = isIndependentProposal(record) ? independentFlow : flow;
    const receipt = active.receipt(record);
    if (!receipt) return null;
    try {
      const prepared = prepareStoredProposal(record);
      return { ...receipt, ...(prepared.solutionHash ? { solutionHash: prepared.solutionHash } : {}) };
    }
    catch { return receipt; }
  } catch { return null; }
}
export const anchorProposalAudit = (record, options) => (
  isIndependentProposal(record) ? independentFlow.anchor(record, options) : flow.anchor(record, options)
);

export function anchorProposalBeforeWrite(record, options = {}) {
  const active = isIndependentProposal(record) ? independentFlow : flow;
  return active.anchor(record, { ...options, persistReceipt: false });
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
  await assertCurrentAuditRecord(record, { adapters });
  const address = configuredAuditRegistryAddress();
  if (!address) throw new Error("AuditRegistry is not configured.");
  return withdrawProposalAudit(
    prepareProposalWithdrawal({
      recordId: record.id, researcherId: record.researcherId, reason,
      actor: AUDIT_ENTITY_ID_SCHEME === 2 ? record.researcherId : undefined,
    }),
    { address, account, adapters, onStatus },
  );
}
export const readProposalAudit = (record, options) => (
  isIndependentProposal(record) ? independentFlow.read(record, options) : flow.read(record, options)
);
