import { signalFundingChange } from "./activitySignals.js";

/** Server-only dashboard projections. A slow older request must never replace
 * a newer confirmed snapshot. These records never authorize a transaction. */
export const FUNDING_POSITIONS = "escrowFundingPositions";
export const OPEN_FUNDING_SELECTIONS = "openFundingSelections";

/** A new block alone does not change a wallet's allocation. Include custody,
 * totals and refund state so payouts/refunds always invalidate old positions. */
export function fundingAllocationBasis(summary = {}) {
  return JSON.stringify([
    summary.chainId, summary.registryAddress?.toLowerCase(), summary.escrowAddress?.toLowerCase(),
    summary.tokenAddress?.toLowerCase(), summary.fundingTarget,
    summary.totalDeposited, summary.totalReleased, summary.totalRefunded,
    summary.state, summary.active, summary.invalidated, summary.currentTranche, summary.expiresAt,
    Number(summary.timestamp) >= Number(summary.expiresAt),
  ]);
}

export async function saveFundingSnapshot({ db, collection, id, snapshot }) {
  if (!Number.isSafeInteger(snapshot.blockNumber) || snapshot.blockNumber < 0) return false;
  const ref = db.collection(collection).doc(id);
  return db.runTransaction(async tx => {
    const old = await tx.get(ref);
    if (old.exists && Number(old.data().blockNumber) > snapshot.blockNumber) return false;
    tx.set(ref, snapshot);
    if (["escrowFundingSummaries", "openFundingSummaries", OPEN_FUNDING_SELECTIONS].includes(collection)) {
      signalFundingChange(tx, db, old.data(), snapshot);
    }
    return true;
  });
}
