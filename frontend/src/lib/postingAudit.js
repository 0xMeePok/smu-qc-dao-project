import {
  AUDIT_HASH_SCHEME,
  AUDIT_REGISTRY_CHAIN_ID,
  OPPORTUNITY_KIND,
  getAuditRegistryAddress,
} from "../config/auditRegistry.js";
import {
  MAX_AUDIT_RETRIES,
  commitOpportunityAudit,
  prepareOpportunityCommit,
  waitForAuditReceipt,
} from "./auditRegistry.js";
import { postingAuditPayload, updatePostingAudit } from "./postings.js";

export function configuredAuditRegistryAddress() {
  try {
    return getAuditRegistryAddress().toLowerCase();
  } catch {
    return null;
  }
}

export function preparePostingAudit(posting, contractAddress = configuredAuditRegistryAddress()) {
  if (!contractAddress) return null;
  const prepared = prepareOpportunityCommit({
    recordId: posting.id,
    payload: postingAuditPayload(posting),
    kind: OPPORTUNITY_KIND.BUSINESS_PROBLEM,
    expiresAt: posting.expiresAt,
  });
  return {
    prepared,
    audit: {
      schemaVersion: AUDIT_HASH_SCHEME,
      chainId: AUDIT_REGISTRY_CHAIN_ID,
      contractAddress: contractAddress.toLowerCase(),
      entityId: prepared.entityId,
      contentHash: prepared.contentHash,
      status: "queued",
      transactionHash: "",
      blockNumber: 0,
      attemptCount: 0,
      lastError: "",
    },
  };
}

function auditErrorMessage(error) {
  const rejected = error?.code === 4001 || /user rejected/i.test(error?.message ?? "");
  if (rejected) return "The posting is live, but the wallet transaction was declined. You can retry from this receipt.";
  return "The posting is live, but Arbitrum Sepolia could not confirm its verification anchor. You can retry safely.";
}

function blockNumber(value) {
  const numeric = Number(value ?? 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

/**
 * Anchors QCDAO-48 after Firestore has accepted the authoritative posting.
 * A known transaction hash is never re-broadcast: retry resumes receipt polling,
 * which avoids duplicate nonces and `_idTaken` reverts after a slow confirmation.
 */
export async function anchorPostingAudit(posting, {
  account,
  adapters,
  onChange,
  maxReceiptRetries = 2,
} = {}) {
  const setup = preparePostingAudit(posting, posting.audit?.contractAddress);
  if (!setup) return null;

  const attemptCount = Math.min(
    MAX_AUDIT_RETRIES,
    Number(posting.audit?.attemptCount ?? 0) + 1,
  );
  let current = {
    ...setup.audit,
    ...(posting.audit ?? {}),
    attemptCount,
    lastError: "",
  };

  const persist = async (patch) => {
    current = { ...current, ...patch };
    onChange?.(current);
    try {
      await updatePostingAudit({ postingId: posting.id, audit: current });
    } catch {
      // Do not abort or rebroadcast a chain transaction because receipt metadata
      // could not be saved. Keep the full state in the mounted UI so the actor can
      // copy the transaction reference and safely reconcile it later.
      current = {
        ...current,
        lastError: "The chain transaction continued, but its receipt could not be saved to Firestore. Keep the transaction reference and retry after reconnecting.",
      };
      onChange?.(current);
    }
  };

  await persist({ status: current.transactionHash ? "pending" : "queued" });

  // A broadcast may have succeeded even when an RPC timed out. Poll the known hash
  // rather than asking the wallet to sign a duplicate commit.
  if (current.transactionHash) {
    try {
      const receipt = await waitForAuditReceipt({
        transactionHash: current.transactionHash,
        adapters,
        maxRetries: maxReceiptRetries,
      });
      if (receipt?.status !== "success") throw new Error("AuditRegistry transaction reverted.");
      await persist({ status: "confirmed", blockNumber: blockNumber(receipt.blockNumber) });
      return current;
    } catch (error) {
      await persist({ status: "failed", lastError: auditErrorMessage(error) });
      throw error;
    }
  }

  try {
    await commitOpportunityAudit(setup.prepared, {
      address: current.contractAddress,
      account,
      adapters,
      maxReceiptRetries,
      onStatus: async (event) => {
        if (event.status === "submitted") {
          await persist({ status: "submitted", transactionHash: event.transactionHash });
        } else if (event.status === "pending") {
          await persist({ status: "pending", transactionHash: event.transactionHash });
        } else if (event.status === "confirmed") {
          await persist({
            status: "confirmed",
            transactionHash: event.transactionHash,
            blockNumber: blockNumber(event.blockNumber),
          });
        }
      },
    });
    return current;
  } catch (error) {
    await persist({
      status: "failed",
      transactionHash: error.transactionHash ?? current.transactionHash,
      lastError: auditErrorMessage(error),
    });
    throw error;
  }
}
