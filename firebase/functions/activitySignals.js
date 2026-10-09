import { FieldValue } from "firebase-admin/firestore";

/** Content-free invalidations. Clients must re-read through the normal verified
 * APIs; these counters never establish visibility, integrity or payment state. */
export function signalActivity(tx, db, { proposalId, problemId }, topic) {
  for (const [collection, id] of [["proposals", proposalId], ["problems", problemId]]) {
    if (id) tx.set(db.collection(`${collection}/${id}/activity`).doc("latest"), {
      [topic]: FieldValue.increment(1),
    }, { merge: true });
  }
}

// Explicit shared financial fields exclude caller-specific permissions, titles,
// timestamps, blocks and reconciliation metadata. Re-reading unchanged chain
// state must not cause another listener refresh and an endless RPC/write loop.
const FINANCIAL_FIELDS = [
  "chainId", "registryAddress", "factoryAddress", "escrowAddress", "poolAddress", "tokenAddress",
  "exists", "state", "status", "fundingTarget", "target", "totalDeposited", "totalReleased",
  "totalRefunded", "feePaid", "refundPool", "outstandingBalance", "balance", "yesWeight", "noWeight", "approvalWeight",
  "totalAllocated", "totalReserved", "totalWithdrawn", "available", "amountBaseUnits",
  "active", "invalidated", "closed", "withdrawn", "paused", "expiresAt", "acceptanceDeadline",
  "currentTranche", "upfrontReleased", "finalReleased", "refundsEnabled", "funderCount",
  "completionDeadline", "evidenceHash", "evidenceVersion", "fundingActivityVersion", "pendingProposalEntityId",
];
export function fundingActivityChanged(previous, next) {
  return !previous || FINANCIAL_FIELDS.some(key => previous[key] !== next[key]);
}
export function signalFundingChange(tx, db, previous, next) {
  if (fundingActivityChanged(previous, next)) signalActivity(tx, db, next, "funding");
}
