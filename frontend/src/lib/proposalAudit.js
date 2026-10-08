import { AUDIT_ENTITY_ID_SCHEME } from "../config/auditRegistry.js";
import { assertCurrentAuditRecord, configuredAuditRegistryAddress, createOpportunityAuditFlow } from "./opportunityAuditFlow.js";
import {
  commitProposalAudit, prepareOpportunityWithdrawal, prepareProposalWithdrawal,
  readOpportunityRevisionIndex, readProposalHashes, readProposalIsAnchored, updateProposalAudit,
  verifyProposalAudit, withdrawOpportunityAudit, withdrawProposalAudit, writeOpportunityAudit,
} from "./auditRegistry.js";
import { findProposal, updateProposalReceipt } from "./proposals.js";
import { INDEPENDENT_PROPOSAL_HASH_SCHEME, isIndependentProposal } from "../../../firebase/functions/independentProposal.js";

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
async function anchorIndependentListing(record, options) {
  let audit;
  let listingProgress = record.audit;
  try {
    audit = await independentFlow.anchor(record, { ...options, onChange: (next) => {
      listingProgress = next;
      options.onChange?.(next);
    } });
  } catch (error) {
    // A confirmed listing can be saved on retry. The escrow contract rejects an
    // independent listing because the researcher is both the opportunity owner
    // and the proposal owner, so publication does not send that second transaction.
    if (/already anchored/i.test(error?.message ?? "") && record.audit?.transactionHash) {
      audit = record.audit;
    } else {
      if (error.receipt?.status === "reverted") {
        listingProgress = { ...listingProgress, status: "failed", transactionHash: "", blockNumber: 0 };
        options.onChange?.(listingProgress);
      }
      if (listingProgress?.transactionHash) {
        error.listingAudit = listingProgress;
      }
      throw error;
    }
  }
  return audit;
}

export const anchorProposalAudit = (record, options) => (
  isIndependentProposal(record) ? anchorIndependentListing(record, options) : flow.anchor(record, options)
);

export function anchorProposalBeforeWrite(record, options = {}) {
  if (isIndependentProposal(record)) {
    return anchorIndependentListing(record, { ...options, persistReceipt: false });
  }
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
  await assertCurrentAuditRecord(record, { adapters });
  const address = configuredAuditRegistryAddress();
  if (!address) throw new Error("AuditRegistry is not configured.");
  if (isIndependentProposal(record)) {
    return withdrawOpportunityAudit(
      prepareOpportunityWithdrawal({
        recordId: record.id, ownerId: record.researcherId, reason,
        actor: AUDIT_ENTITY_ID_SCHEME === 2 ? record.researcherId : undefined,
        hashScheme: INDEPENDENT_PROPOSAL_HASH_SCHEME,
      }),
      { address, account, adapters, onStatus },
    );
  }
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
