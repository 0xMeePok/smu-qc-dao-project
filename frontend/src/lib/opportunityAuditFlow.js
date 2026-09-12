import {
  AUDIT_HASH_SCHEME,
  AUDIT_REGISTRY_CHAIN_ID,
  getAuditRegistryAddress,
} from "../config/auditRegistry.js";
import {
  MAX_AUDIT_RETRIES,
  commitOpportunityAudit,
  prepareOpportunityCommit,
  verifyOpportunityAudit,
  waitForAuditReceipt,
} from "./auditRegistry.js";
import { auditErrorMessage } from "./errors.js";

const AUDIT_STATUSES = new Set(["queued", "submitted", "pending", "confirmed", "failed"]);

export function configuredAuditRegistryAddress() {
  try {
    return getAuditRegistryAddress().toLowerCase();
  } catch {
    return null;
  }
}

function blockNumber(value) {
  const numeric = Number(value ?? 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function storedAudit(setup, opportunity) {
  const stored = opportunity.audit ?? {};
  return {
    ...setup.audit,
    status: AUDIT_STATUSES.has(stored.status) ? stored.status : setup.audit.status,
    transactionHash: stored.transactionHash ?? "",
    blockNumber: blockNumber(stored.blockNumber),
    attemptCount: Number(stored.attemptCount ?? 0),
    lastError: stored.lastError ?? "",
  };
}

/**
 * Creates the shared chain-delivery flow for one Firestore opportunity kind.
 * The contract, receipt state machine and recovery behaviour stay identical;
 * only the canonical payload, enum value and Firestore updater vary by kind.
 */
export function createOpportunityAuditFlow({
  kind,
  payloadFor,
  persistAudit,
  entityLabel,
  prepareCommit,
  loadRecord,
  commitAudit = commitOpportunityAudit,
  verifyAudit = verifyOpportunityAudit,
  persistConfirmed = false,
  enforceWalletRetryLimit = false,
}) {
  const prepare = (opportunity) => {
    const address = configuredAuditRegistryAddress();
    if (!address) return null;
    const prepared = prepareCommit ? prepareCommit(opportunity) : prepareOpportunityCommit({
      recordId: opportunity.id,
      payload: payloadFor(opportunity),
      kind,
      expiresAt: opportunity.expiresAt,
      hashScheme: opportunity.audit?.schemaVersion ?? AUDIT_HASH_SCHEME,
    });
    return {
      address,
      prepared,
      audit: {
        schemaVersion: AUDIT_HASH_SCHEME,
        chainId: AUDIT_REGISTRY_CHAIN_ID,
        entityId: prepared.entityId,
        contentHash: prepared.contentHash,
        status: "queued",
        transactionHash: "",
        blockNumber: 0,
        attemptCount: 0,
        lastError: "",
      },
    };
  };

  const receipt = (opportunity) => {
    const setup = prepare(opportunity);
    return setup ? storedAudit(setup, opportunity) : null;
  };

  const read = async (opportunity, { adapters } = {}) => {
    // Rechecks must hash the current server document, never a page snapshot or
    // the stored receipt's hash. A failed server read must fail verification.
    const current = loadRecord
      ? await loadRecord(opportunity.id, { fromServer: true })
      : opportunity;
    if (!current) throw new Error(`This ${entityLabel} is no longer available or you do not have access.`);
    const setup = prepare(current);
    if (!setup) throw new Error("AuditRegistry is not configured.");
    return verifyAudit(setup.prepared, { address: setup.address, adapters });
  };

  const anchor = async (opportunity, {
    account,
    adapters,
    onChange,
    persistReceipt = true,
    maxReceiptRetries = 2,
  } = {}) => {
    const setup = prepare(opportunity);
    if (!setup) throw new Error("AuditRegistry is not configured.");

    if (enforceWalletRetryLimit && !opportunity.audit?.transactionHash && Number(opportunity.audit?.attemptCount ?? 0) >= MAX_AUDIT_RETRIES) {
      throw new Error("The wallet retry limit has been reached. Ask an administrator to reset verification attempts.");
    }
    const attemptCount = Math.min(
      MAX_AUDIT_RETRIES,
      Number(opportunity.audit?.attemptCount ?? 0) + 1,
    );
    let current = {
      ...storedAudit(setup, opportunity),
      attemptCount,
      lastError: "",
    };

    const persist = async (patch) => {
      const next = { ...current, ...patch };
      const trustedConfirmation = persistReceipt
        && persistConfirmed
        && next.status === "confirmed";
      if (!trustedConfirmation) {
        current = next;
        onChange?.(current);
      }
      if (!persistReceipt) return;
      // Firestore rules reject client `confirmed` writes — the contract is the
      // verifier. Proposal confirmation goes through the trusted callable;
      // opportunity flows keep confirmed state in memory.
      if (next.status === "confirmed" && !persistConfirmed) return;
      try {
        await persistAudit({ recordId: opportunity.id, audit: next });
        if (trustedConfirmation) {
          current = next;
          onChange?.(current);
        }
      } catch {
        if (trustedConfirmation && next.transactionHash) {
          const confirmationError = "The transaction is mined, but trusted server confirmation is still pending. Retry verification to save and recheck this transaction.";
          current = {
            ...next,
            status: "pending",
            lastError: current.lastError.includes(confirmationError)
              ? current.lastError
              : [current.lastError, confirmationError].filter(Boolean).join(" ").slice(0, 500),
          };
          onChange?.(current);
          return;
        }
        const persistenceError = current.transactionHash
          ? "The transaction was submitted, but its receipt could not be saved to Firestore. Keep the transaction reference and retry after reconnecting."
          : "The audit status could not be saved to Firestore. No transaction reference was received.";
        current = {
          ...current,
          lastError: current.lastError.includes(persistenceError)
            ? current.lastError
            : [current.lastError, persistenceError].filter(Boolean).join(" ").slice(0, 500),
        };
        onChange?.(current);
      }
    };

    await persist({ status: current.transactionHash ? "pending" : "queued" });

    if (current.transactionHash) {
      try {
        const chainReceipt = await waitForAuditReceipt({
          transactionHash: current.transactionHash,
          adapters,
          maxRetries: maxReceiptRetries,
        });
        if (chainReceipt?.status !== "success") throw new Error("AuditRegistry transaction reverted.");
        const verification = await verifyAudit(setup.prepared, {
          address: setup.address,
          adapters,
        });
        if (!verification.verified) {
          throw new Error(`The confirmed transaction does not match this ${entityLabel} on the configured AuditRegistry.`);
        }
        await persist({ status: "confirmed", blockNumber: blockNumber(chainReceipt.blockNumber) });
        return current;
      } catch (error) {
        await persist({
          status: "failed",
          ...(error.code === "AUDIT_TRANSACTION_CANCELLED" ? { transactionHash: "", blockNumber: 0 } : {}),
          lastError: auditErrorMessage(error),
        });
        throw error;
      }
    }

    try {
      const result = await commitAudit(setup.prepared, {
        address: setup.address,
        account,
        adapters,
        maxReceiptRetries,
        onStatus: async (event) => {
          if (event.status === "submitted") {
            await persist({ status: "submitted", transactionHash: event.transactionHash });
          } else if (event.status === "pending") {
            await persist({ status: "pending", transactionHash: event.transactionHash });
          }
        },
      });
      const verification = await verifyAudit(setup.prepared, {
        address: setup.address,
        adapters,
      });
      if (!verification.verified) {
        throw new Error(`The ${entityLabel} does not match the configured AuditRegistry after confirmation.`);
      }
      await persist({
        status: "confirmed",
        transactionHash: result.transactionHash,
        blockNumber: blockNumber(result.blockNumber),
      });
      return current;
    } catch (error) {
      await persist({
        status: "failed",
        transactionHash: error.code === "AUDIT_TRANSACTION_CANCELLED"
          ? "" : error.transactionHash ?? current.transactionHash,
        lastError: auditErrorMessage(error),
      });
      throw error;
    }
  };

  return Object.freeze({ prepare, receipt, read, anchor });
}
