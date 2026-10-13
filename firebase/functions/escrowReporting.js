import { fundingAllocationBasis } from "./fundingSnapshots.js";
import { confirmedRefundMetadata } from "./escrowRefundMetadata.js";

const wallet = value => /^0x[0-9a-f]{40}$/i.test(value ?? "");
const units = value => {
  if (typeof value !== "string" || !/^[0-9]{1,78}$/.test(value)) return null;
  const number = BigInt(value);
  return number < 2n ** 256n ? number : null;
};
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const lifecycleTypes = new Set(["EscrowCreated", "SelectionLocked", "Approval", "SelectionInvalidated", "Cancelled",
  "Expired", "MilestoneSubmitted", "TrancheReleased", "Voided", "RefundClaimed"]);

/** Display-only contributor allocation. Never join a stale wallet allocation to
 * a newer payout/refund, and never use a profile label as a financial identity. */
export function confirmedContributors(summary, rows = [], { truncated = false, names = new Map() } = {}) {
  const unknown = { available: false, complete: false, items: [], blockNumber: summary?.blockNumber ?? null };
  if (!summary || !(summary.snapshotVerified === true || (summary.reconciliation?.complete && summary.reconciliation?.matched))) return unknown;
  const total = units(summary.totalDeposited), released = units(summary.totalReleased), refunded = units(summary.totalRefunded), held = units(summary.outstandingBalance);
  if ([total, released, refunded, held].some(value => value === null) || total !== released + refunded + held) return unknown;
  const basis = fundingAllocationBasis(summary), seen = new Set(), items = [];
  let committedSum = 0n, releasedSum = 0n, refundedSum = 0n, heldSum = 0n;
  for (const row of rows) {
    if (!row || row.snapshotVerified !== true || !wallet(row.uid) || row.proposalId !== summary.proposalId
        || row.chainId !== summary.chainId || !same(row.registryAddress, summary.registryAddress)
        || !Number.isSafeInteger(row.blockNumber) || row.blockNumber > summary.blockNumber
        || fundingAllocationBasis(row) !== basis) continue;
    const address = row.uid.toLowerCase();
    if (seen.has(address)) return unknown;
    const committed = units(row.committed), paid = units(row.released), returned = units(row.refunded), retained = units(row.locked), claimable = units(row.claimable);
    if ([committed, paid, returned, retained, claimable].some(value => value === null)
        || committed === 0n || committed !== paid + returned + retained || claimable > retained) return unknown;
    seen.add(address); committedSum += committed; releasedSum += paid; refundedSum += returned; heldSum += retained;
    items.push({ walletAddress: address, displayName: names.get(address) ?? null,
      committed: committed.toString(), released: paid.toString(), refunded: returned.toString(), held: retained.toString(),
      claimable: claimable.toString(), shareBps: total ? (committed * 10_000n / total).toString() : "0" });
  }
  if (committedSum > total || releasedSum > released || refundedSum > refunded || heldSum > held) return unknown;
  const complete = !truncated && committedSum === total && releasedSum === released && refundedSum === refunded && heldSum === held;
  if (!items.length && total > 0n) return unknown;
  return { available: true, complete, items: items.sort((a, b) => {
    const difference = BigInt(b.committed) - BigInt(a.committed);
    return difference ? difference > 0n ? 1 : -1 : a.walletAddress.localeCompare(b.walletAddress);
  }), blockNumber: summary.blockNumber };
}

/** Receipt-derived status history; a queued worker or database-only request is
 * never presented as an already confirmed lifecycle transition. */
export function confirmedLifecycle(summary, rows = [], { truncated = false } = {}) {
  const events = rows.filter(event => event?.verified === true && lifecycleTypes.has(event.eventType)
    && event.chainId === summary?.chainId && same(event.registryAddress, summary?.registryAddress)
    && same(event.escrowAddress, summary?.escrowAddress) && event.proposalId === summary?.proposalId
    && Number.isSafeInteger(event.blockNumber) && event.blockNumber <= summary.blockNumber)
    .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
  const refundEvent = events.find(event => event.refundReason && event.eventType !== "RefundClaimed") ?? null;
  return { events, hasMore: truncated,
    refundReason: refundEvent?.refundReason ?? confirmedRefundMetadata(summary, summary).refundReason ?? null, refundEvent };
}

export async function publicContributorNames(db, rows) {
  const addresses = [...new Set(rows.map(row => row?.uid?.toLowerCase()).filter(wallet))].slice(0, 200);
  if (!addresses.length) return new Map();
  try {
    const profiles = await db.getAll(...addresses.map(address => db.collection("users").doc(address)));
    return new Map(profiles.flatMap((profile, index) => {
      const name = profile.data()?.fullName;
      return typeof name === "string" && name.trim() ? [[addresses[index], name.trim().slice(0, 120)]] : [];
    }));
  } catch { return new Map(); }
}
