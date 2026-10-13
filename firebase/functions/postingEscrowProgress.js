import { escrowFundingRequirementMet } from "./escrowCustody.js";
import { isIndependentProposal } from "./independentProposal.js";

const same = (a, b) => Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase());
const units = value => typeof value === "string" && /^\d{1,78}$/.test(value) && BigInt(value) < 2n ** 256n;
const visible = row => row.status !== "draft" && !row.moderated
  && !["hidden", "removed"].includes(row.moderationStatus);

/** A keeper's new block/timestamp does not change card progress. Ignore those
 * heartbeats and body edits to avoid rebuilding a posting for every refresh. */
export function postingProgressChanged(kind, before, after) {
  if (!before || !after) return before !== after;
  const fields = kind === "summary" ? ["proposalId", "problemId", "chainId", "registryAddress", "escrowAddress",
    "tokenAddress", "tokenDecimals", "tokenSymbol", "researcherId", "postingOwnerId", "fundingTarget",
    "totalDeposited", "totalReleased", "totalRefunded", "outstandingBalance", "custodyBalance", "state", "snapshotVerified"]
    : kind === "proposal" ? ["problemId", "status", "moderated", "moderationStatus", "researcherId", "proposalKind", "opportunityType"]
      : ["status", "moderated", "moderationStatus", "ownerId", "opportunityType"];
  if (fields.some(field => before[field] !== after[field])) return true;
  if (kind === "summary") return before.reconciliation?.complete !== after.reconciliation?.complete
    || before.reconciliation?.matched !== after.reconciliation?.matched;
  if (kind === "proposal") return before.fundingTerms?.token !== after.fundingTerms?.token
    || before.fundingTerms?.target !== after.fundingTerms?.target || before.audit?.status !== after.audit?.status;
  return false;
}

/** Public card totals contain only verified contract projections. Different
 * tokens stay separate; a posting's currency budget is never a token target.
 * This display cache cannot authorize selection, payment or a refund. */
export function postingEscrowProgress({ posting, proposals = [], summaries = [], config, truncated = false }) {
  if (!posting || !visible(posting) || posting.opportunityType === "open-funding") return null;
  const candidates = proposals.filter(row => visible(row) && row.fundingTerms && !isIndependentProposal(row));
  const latest = new Map();
  for (const row of summaries) {
    if (row.chainId !== config.chainId || !same(row.registryAddress, config.address)) continue;
    if (!latest.has(row.proposalId) || latest.get(row.proposalId).blockNumber < row.blockNumber) latest.set(row.proposalId, row);
  }
  const groups = new Map();
  let unavailableItems = 0;
  for (const proposal of candidates) {
    const row = latest.get(proposal.id), terms = proposal.fundingTerms;
    const valid = row && proposal.audit?.status === "confirmed"
      && (row.snapshotVerified === true || (row.reconciliation?.complete === true && row.reconciliation?.matched === true))
      && same(row.researcherId, proposal.researcherId) && same(row.postingOwnerId, posting.ownerId)
      && same(row.tokenAddress, terms.token) && row.fundingTarget === terms.target
      && Number.isSafeInteger(row.blockNumber) && row.blockNumber >= 0
      && Number.isSafeInteger(row.timestamp) && row.timestamp > 0
      && Number.isInteger(row.tokenDecimals) && row.tokenDecimals >= 0 && row.tokenDecimals <= 77
      && [row.fundingTarget, row.totalDeposited, row.totalReleased, row.totalRefunded, row.outstandingBalance, row.custodyBalance].every(units)
      && BigInt(row.fundingTarget) > 0n && BigInt(row.totalDeposited) <= BigInt(row.fundingTarget)
      && BigInt(row.totalDeposited) === BigInt(row.totalReleased) + BigInt(row.totalRefunded) + BigInt(row.outstandingBalance)
      && BigInt(row.custodyBalance) >= BigInt(row.outstandingBalance);
    if (!valid) { unavailableItems++; continue; }
    const key = `${row.tokenAddress.toLowerCase()}:${row.tokenDecimals}`;
    const old = groups.get(key) ?? { tokenAddress: row.tokenAddress.toLowerCase(), tokenDecimals: row.tokenDecimals,
      tokenSymbol: row.tokenSymbol, totalDeposited: 0n, fundingTarget: 0n, count: 0,
      blockNumber: row.blockNumber, timestamp: row.timestamp, fundingRequirementMet: true };
    old.totalDeposited += BigInt(row.totalDeposited); old.fundingTarget += BigInt(row.fundingTarget); old.count++;
    old.blockNumber = Math.min(old.blockNumber, row.blockNumber); old.timestamp = Math.min(old.timestamp, row.timestamp);
    old.fundingRequirementMet &&= escrowFundingRequirementMet(row);
    groups.set(key, old);
  }
  return { source: "confirmed-escrow-snapshots", available: !truncated && unavailableItems === 0,
    unavailableItems, truncated, proposalCount: candidates.length,
    groups: [...groups.values()].map(row => ({ ...row, totalDeposited: row.totalDeposited.toString(),
      fundingTarget: row.fundingTarget.toString(), snapshotVerified: true })) };
}

/** The transaction observes proposal visibility and snapshots together, so an
 * older trigger cannot publish totals from before a concurrent moderation or
 * newer custody snapshot. It adds a field alongside legacy marketplace metrics. */
export async function refreshPostingEscrowProgress({ db, problemId, config }) {
  if (typeof problemId !== "string" || !problemId || problemId.includes("/")) return;
  return db.runTransaction(async tx => {
    const [posting, proposals, summaries] = await Promise.all([
      tx.get(db.collection("problems").doc(problemId)),
      tx.get(db.collection("proposals").where("problemId", "==", problemId).limit(201)),
      tx.get(db.collection("escrowFundingSummaries").where("problemId", "==", problemId).limit(201)),
    ]);
    if (!posting.exists) return;
    const escrowFunding = postingEscrowProgress({ posting: posting.data(), config,
      proposals: proposals.docs.slice(0, 200).map(doc => ({ ...doc.data(), id: doc.id })),
      summaries: summaries.docs.slice(0, 200).map(doc => doc.data()),
      truncated: proposals.size > 200 || summaries.size > 200 });
    tx.set(db.collection("opportunityMetrics").doc(problemId), { escrowFunding }, { merge: true });
    return escrowFunding;
  });
}
