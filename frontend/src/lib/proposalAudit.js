import { encodeFunctionData } from "viem";
import { AUDIT_ENTITY_ID_SCHEME, AUDIT_REGISTRY_ABI, AUDIT_REGISTRY_CONFIG } from "../config/auditRegistry.js";
import { assertCurrentAuditRecord, configuredAuditRegistryAddress, createOpportunityAuditFlow } from "./opportunityAuditFlow.js";
import {
  commitProposalAudit, prepareOpportunityWithdrawal, prepareProposalWithdrawal,
  readOpportunityRevisionIndex, readProposalHashes, readProposalIsAnchored, updateProposalAudit,
  createWagmiAuditAdapters, verifyProposalAudit, waitForAuditReceipt,
  withdrawOpportunityAudit, withdrawProposalAudit, writeOpportunityAudit,
} from "./auditRegistry.js";
import { findProposal, updateProposalReceipt } from "./proposals.js";
import { INDEPENDENT_PROPOSAL_HASH_SCHEME, isIndependentProposal } from "../../../firebase/functions/independentProposal.js";

export { proposalAuditPayload } from "../../../firebase/functions/proposalAuditPayload.js";
import { prepareIndependentEscrowCommit, prepareStoredProposal } from "../../../firebase/functions/proposalAuditPayload.js";
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
async function commitIndependentListingEscrow(record, options) {
  const prepared = prepareIndependentEscrowCommit(record);
  const revision = await readOpportunityRevisionIndex(prepared.opportunityId, options);
  const operation = withOpportunityRevisionIndex(prepared, revision);
  let current = { ...options.escrowAudit };
  const emit = async (patch) => {
    current = { ...current, ...patch };
    options.onEscrowChange?.(current);
  };
  try {
    if (current.transactionHash) {
      // A missing receipt is not proof that a submitted transaction failed.
      // Check the same hash before considering another wallet signature.
      const recoveredOperation = current.functionName === "updateHashes" ? asProposalUpdate(operation)
        : current.functionName === operation.functionName ? operation : null;
      if (!recoveredOperation || current.entityId !== operation.entityId || current.proposalHash !== operation.proposalHash
          || current.solutionHash !== operation.solutionHash || current.fundingTermsHash !== operation.fundingTermsHash
          || current.opportunityRevisionIndex !== revision) {
        throw new Error("Finish verifying the submitted escrow transaction before changing this listing or its payment plan.");
      }
      const receipt = await waitForAuditReceipt({
        transactionHash: current.transactionHash,
        adapters: options.adapters,
        maxRetries: options.maxReceiptRetries ?? 2,
      });
      if (receipt?.status !== "success") {
        const error = new Error("The escrow transaction reverted.");
        error.receipt = receipt;
        throw error;
      }
      const adapters = options.adapters ?? createWagmiAuditAdapters();
      if (typeof adapters.getTransaction !== "function") throw new Error("Reading the escrow transaction is required before publication.");
      const hash = receipt.transactionHash ?? current.transactionHash;
      const transaction = await adapters.getTransaction({ hash, chainId: AUDIT_REGISTRY_CONFIG.chainId });
      const expectedCallData = encodeFunctionData({ abi: AUDIT_REGISTRY_ABI,
        functionName: recoveredOperation.functionName, args: recoveredOperation.args });
      const same = (left, right) => String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
      if (!same(transaction?.hash, hash) || !same(transaction?.to, configuredAuditRegistryAddress())
          || !same(transaction?.from, record.researcherId)
          || Number(transaction?.chainId) !== AUDIT_REGISTRY_CONFIG.chainId
          || !same(transaction?.input ?? transaction?.data, expectedCallData)) {
        throw new Error("The confirmed escrow transaction does not match this listing and payment plan.");
      }
      await emit({ status: "confirmed", transactionHash: hash, blockNumber: Number(receipt.blockNumber) });
      return current;
    }
    let writeOperation = operation;
    if (await readProposalIsAnchored(operation.entityId, options)) {
      try {
        await assertAmendmentIsNew(operation, options);
      } catch (error) {
        if (/already anchored/i.test(error?.message ?? "")) return current;
        throw error;
      }
      writeOperation = asProposalUpdate(operation);
    }
    await emit({
      status: "queued", transactionHash: "", blockNumber: 0,
      entityId: operation.entityId, proposalHash: operation.proposalHash,
      solutionHash: operation.solutionHash, fundingTermsHash: operation.fundingTermsHash,
      opportunityRevisionIndex: revision, functionName: writeOperation.functionName,
    });
    const writeOptions = { ...options, onStatus: async (event) => {
      await emit({ status: event.status,
        ...(event.transactionHash ? { transactionHash: event.transactionHash } : {}),
        ...(event.blockNumber ? { blockNumber: Number(event.blockNumber) } : {}),
      });
      await options.onStatus?.(event);
    } };
    await (writeOperation.functionName === "updateHashes"
      ? updateProposalAudit(writeOperation, writeOptions)
      : commitProposalAudit(writeOperation, writeOptions));
    return current;
  } catch (error) {
    // Only a known cancellation or mined revert permits another submission.
    // Network and receipt errors retain the original hash for a later check.
    if (error.code === "AUDIT_TRANSACTION_CANCELLED" || error.receipt?.status === "reverted") {
      await emit({ status: "failed", transactionHash: "", blockNumber: 0 });
    }
    error.escrowAudit = current;
    throw error;
  }
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
    if (record?.fundingTerms && /already anchored/i.test(error?.message ?? "") && record.audit?.transactionHash) {
      audit = record.audit;
    } else {
      if (error.receipt?.status === "reverted") {
        listingProgress = { ...listingProgress, status: "failed", transactionHash: "", blockNumber: 0 };
        options.onChange?.(listingProgress);
      }
      if (listingProgress?.transactionHash) {
        error.listingAudit = listingProgress;
        if (options.escrowAudit) error.escrowAudit = options.escrowAudit;
      }
      throw error;
    }
  }
  if (record?.fundingTerms) {
    try {
      await commitIndependentListingEscrow(record, options);
    } catch (error) {
      error.listingAudit = audit;
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
