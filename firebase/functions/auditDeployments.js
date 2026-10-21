import activeRegistry from "./auditRegistry.contract.json" with { type: "json" };
import historicalRegistries from "./auditRegistry.history.json" with { type: "json" };
import { decodeMemberCall } from "./memberCall.js";

const same = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();
const HASH = /^0x[0-9a-f]{64}$/i;

/** Only repository-owned deployment facts may select an ABI or custody factory. */
export function knownAuditDeployment(address, chainId, { activeConfig = activeRegistry, history = historicalRegistries } = {}) {
  const deployment = [activeConfig, ...history].find(config =>
    Number(config.chainId) === Number(chainId) && same(config.address, address));
  if (!deployment) throw new Error("The transaction does not belong to a known AuditRegistry deployment on this chain.");
  return deployment;
}

export function isActiveAuditDeployment(config, activeConfig = activeRegistry) {
  return Number(config.chainId) === Number(activeConfig.chainId) && same(config.address, activeConfig.address);
}

/** Receipts deliberately retain their existing nine-field Firestore schema. */
export async function resolveAuditDeployment(record, {
  getTransaction, activeConfig = activeRegistry, history = historicalRegistries, transaction, receipt, matchesReceipt,
} = {}) {
  const hash = record?.audit?.transactionHash;
  if (!hash) return activeConfig;
  if (!HASH.test(hash)) throw new Error("The audit transaction hash is invalid.");
  if (!transaction && typeof getTransaction !== "function") throw new Error("Reading the audit transaction is required to identify its deployment.");
  const chainId = Number(record.audit?.chainId ?? activeConfig.chainId);
  const tx = transaction ?? await getTransaction({ hash, chainId });
  if (!tx || !same(tx.hash, hash) || Number(tx.chainId) !== chainId) {
    throw new Error("The transaction does not belong to this audit receipt and chain.");
  }
  if (receipt && typeof matchesReceipt === "function") {
    if (!same(receipt.transactionHash, hash)) throw new Error("The transaction does not belong to this audit receipt and chain.");
    // A receipt can contain effects from several operations and registries.
    // Select only repository-owned deployments with an event for this exact
    // record; neither the bundler target nor wallet calldata identifies it.
    const matches = [activeConfig, ...history].filter(config => {
      if (Number(config.chainId) !== chainId) return false;
      try { return Boolean(matchesReceipt(config, receipt)); } catch { return false; }
    });
    if (matches.length !== 1) throw new Error("Mismatch detected: the receipt does not belong to a known, unambiguous AuditRegistry deployment for this record.");
    return matches[0];
  }
  return knownAuditDeployment(decodeMemberCall(tx, { sender: record.researcherId ?? record.ownerId })?.to, chainId, { activeConfig, history });
}

export function assertActiveAuditDeployment(config, activeConfig = activeRegistry) {
  if (!isActiveAuditDeployment(config, activeConfig)) {
    throw new Error("This record belongs to an earlier AuditRegistry deployment and is read-only. Its original verification remains available; create a new posting for the current funding workflow.");
  }
  return config;
}
