/** Values fixed once an escrow verification or a mined hash has been checked.
 * Mutable escrow state, totals, approvals, votes, evidence, balances and
 * workflow flags are never stored here. Entries are process-local and bounded.
 */

const MAX_ENTRIES = 500;
const entries = new Map();

const IDENTITY = ["postingId", "proposalId", "token", "fundingTarget", "funderVoting", "proposalOwner", "problemOwner",
  "tokenRegistry", "auditRegistry", "milestoneCount", "expiresAt", "tokenDecimals"];

export function resetImmutableChainCache() {
  entries.clear();
}

function remember(key, value) {
  if (entries.has(key)) entries.delete(key);
  entries.set(key, value);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  return value;
}

function recall(key) {
  if (!entries.has(key)) return undefined;
  const value = entries.get(key);
  entries.delete(key);
  entries.set(key, value);
  return value;
}

const same = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();
const escrowKey = (chainId, registry, factory, entityId) => `escrow:${chainId}:${String(registry).toLowerCase()}:${String(factory).toLowerCase()}:${String(entityId).toLowerCase()}`;
const tokenKey = (chainId, token) => `decimals:${chainId}:${String(token).toLowerCase()}`;
const transactionKey = (chainId, hash) => `tx:${chainId}:${String(hash).toLowerCase()}`;
const receiptKey = (chainId, hash) => `receipt:${chainId}:${String(hash).toLowerCase()}`;

function milestoneTuple(milestone) {
  const bps = milestone.bps ?? milestone[0];
  const reviewWindow = milestone.reviewWindow ?? milestone[1];
  const descriptionHash = milestone.descriptionHash ?? milestone[2];
  const grossAmount = milestone.grossAmount ?? milestone[3];
  return { bps, reviewWindow, descriptionHash, grossAmount, 0: bps, 1: reviewWindow, 2: descriptionHash, 3: grossAmount };
}

function opportunityTuple(owner, expiresAt) {
  return { owner, expiresAt, 0: owner, 5: expiresAt };
}

/** Remember a successful canonical verification. Later display reads replay it. */
export function storeVerifiedEscrow({ chainId, registry, factory, entityId, escrowAddress, identity, milestones, opportunityOwner, opportunityExpiresAt, configuredFactory, reverseRegistry }) {
  if (!chainId || !registry || !factory || !entityId || !escrowAddress || !identity) return;
  remember(escrowKey(chainId, registry, factory, entityId), {
    escrowAddress,
    configuredFactory: configuredFactory ?? factory,
    reverseRegistry: reverseRegistry ?? registry,
    identity: Object.fromEntries(IDENTITY.map(name => [name, identity[name]])),
    milestones: (milestones ?? []).map(milestoneTuple),
    opportunity: opportunityTuple(opportunityOwner, opportunityExpiresAt),
  });
}

export function readVerifiedEscrow({ chainId, registry, factory, entityId }) {
  return recall(escrowKey(chainId, registry, factory, entityId));
}

/** A cached immutable getter, or undefined when this read must hit the chain. */
export function cachedEscrowRead({ chainId, registry, factory, entityId, address, functionName, args = [] }) {
  const record = readVerifiedEscrow({ chainId, registry, factory, entityId });
  if (!record) return undefined;
  const target = String(address).toLowerCase();
  if (same(target, registry)) {
    if (functionName === "fundingFactory") return record.configuredFactory;
    if (functionName === "proposalEscrow" && same(args[0], entityId)) return record.escrowAddress;
    if (functionName === "getOpportunity" && record.opportunity) return record.opportunity;
  }
  if (same(target, factory)) {
    if (functionName === "auditRegistry") return record.reverseRegistry;
    if (functionName === "escrowForProposal" && same(args[0], entityId)) return record.escrowAddress;
  }
  if (same(target, record.escrowAddress)) {
    if (Object.hasOwn(record.identity, functionName) && args.length === 0) return record.identity[functionName];
    if (functionName === "milestoneAt" && record.milestones[Number(args[0])]) return record.milestones[Number(args[0])];
  }
  return undefined;
}

export function readCachedTokenDecimals(chainId, token) {
  return recall(tokenKey(chainId, token));
}

export function storeTokenDecimals(chainId, token, decimals) {
  if (!Number.isInteger(decimals)) return;
  remember(tokenKey(chainId, token), decimals);
}

export function readCachedTransaction(chainId, hash) {
  return recall(transactionKey(chainId, hash));
}

export function storeTransaction(chainId, hash, transaction) {
  if (!transaction || typeof transaction.blockNumber !== "bigint") return;
  remember(transactionKey(chainId, hash), transaction);
}

export function readCachedReceipt(chainId, hash) {
  return recall(receiptKey(chainId, hash));
}

export function storeReceipt(chainId, hash, receipt) {
  if (!receipt || receipt.status !== "success" || typeof receipt.blockNumber !== "bigint") return;
  remember(receiptKey(chainId, hash), receipt);
}
