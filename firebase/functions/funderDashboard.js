import { HttpsError } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { canReadContent } from "./moderation.js";
import { ownerReviewSummary } from "./ownerReviews.js";
import { FUNDING_EVENTS, FUNDING_SUMMARIES, deploymentKey, loadFundingContext, refreshEscrowDashboardSnapshot } from "./escrowFunding.js";
import { OPEN_FUNDING_SUMMARIES, getOpenFundingSummary, supportsOpenFunding } from "./openFunding.js";
import { same } from "./escrowFundingEvents.js";
import { isIndependentProposal } from "./independentProposal.js";
import { readIndependentFundingPortfolio } from "./independentFunding.js";
import { FUNDING_POSITIONS, OPEN_FUNDING_SELECTIONS, fundingAllocationBasis } from "./fundingSnapshots.js";

const CAP = 50, APPROACH_CAP = 200;
const iso = value => value?.toDate?.().toISOString?.() ?? null;
const WORKFLOW = { Open: "submitted", Locked: "pending_approval", Active: "accepted", Released: "completed",
  Cancelled: "cancelled", Refunded: "refunded", Expired: "expired", Voided: "invalidated" };
const units = value => typeof value === "string" && /^[0-9]{1,78}$/.test(value);
const address = value => /^0x[0-9a-f]{40}$/i.test(value || "");
const scoped = (row, config) => row && row.chainId === config.chainId && same(row.registryAddress, config.address)
  && Number.isSafeInteger(row.blockNumber) && row.blockNumber >= 0;
const confirmed = row => row?.snapshotVerified === true || (row?.reconciliation?.complete === true && row?.reconciliation?.matched === true);
const hidden = row => row?.moderated || ["hidden", "removed"].includes(row?.moderationStatus);
const fail = (code, message) => { throw new HttpsError(code, message); };

/** QCDAO-94: member's opportunities, approaches and saved confirmed commitments.
 * Exact token base units are grouped by chain and token; currencies never mix. */
export async function getFunderDashboard({ db, client, config, uid, now = Timestamp.now() }) {
  const profile = await db.collection("users").doc(uid).get();
  if (!profile.exists || profile.data().suspended) fail("permission-denied", "An active member profile is required.");
  const [owned, deposits, approachesPage, positionsPage] = await Promise.all([
    db.collection("problems").where("ownerId", "==", uid).where("opportunityType", "==", "open-funding").limit(CAP + 1).get(),
    db.collection(FUNDING_EVENTS).where("actor", "==", uid).where("eventType", "==", "Deposit")
      .where("registryAddress", "==", config.address.toLowerCase()).limit(APPROACH_CAP + 1).get(),
    db.collection("proposals").where("postingOwnerId", "==", uid).limit(APPROACH_CAP + 1).get(),
    db.collection(FUNDING_POSITIONS).where("uid", "==", uid).limit(APPROACH_CAP + 1).get(),
  ]);
  const opportunities = [], ownedById = new Map(owned.docs.map(doc => [doc.id, doc.data()]));
  let unavailablePools = 0;
  // Saved rows avoid RPC work. Missing snapshots are filled once through the
  // same verification as details, without settlement or transaction submission.
  const commitmentIds = new Set(deposits.docs.slice(0, APPROACH_CAP)
    .filter(doc => doc.data().verified === true && doc.data().chainId === config.chainId).map(doc => doc.data().proposalId));
  const positions = new Map();
  for (const doc of positionsPage.docs.slice(0, APPROACH_CAP)) {
    const row = doc.data();
    if (!scoped(row, config) || !same(row.uid, uid) || !confirmed(row)) continue;
    positions.set(row.proposalId, row);
    if (units(row.committed) && BigInt(row.committed) > 0n) commitmentIds.add(row.proposalId);
  }
  const prefix = deploymentKey(config), summaryCache = new Map();
  const readSaved = async (collection, id) => {
    const key = `${collection}/${id}`;
    if (!summaryCache.has(key)) summaryCache.set(key, db.collection(collection).doc(`${prefix}_${id}`).get().then(snap => {
      const data = snap.data();
      return scoped(data, config) && (collection !== FUNDING_SUMMARIES || confirmed(data)) ? data : null;
    }));
    return summaryCache.get(key);
  };
  const poolFills = new Map(), escrowFills = new Map();
  const fillPool = async (id, proposalId) => {
    const key = `${id}/${proposalId || ""}`;
    if (!poolFills.has(key)) poolFills.set(key, (async () => {
      try {
        const pool = await getOpenFundingSummary({ db, client, config, uid, problemId: id, proposalId });
        summaryCache.set(`${OPEN_FUNDING_SUMMARIES}/${id}`, pool);
        for (const offer of pool.selections || []) summaryCache.delete(`${OPEN_FUNDING_SELECTIONS}/${offer.proposalId}`);
        return pool;
      } catch { return null; }
    })());
    return poolFills.get(key);
  };
  const fillEscrow = async id => {
    if (!escrowFills.has(id)) escrowFills.set(id, (async () => {
      try {
        const result = await refreshEscrowDashboardSnapshot({ db, client, config, uid, proposalId: id });
        summaryCache.set(`${FUNDING_SUMMARIES}/${id}`, result.summary);
        if (result.position) {
          positions.set(id, result.position);
          if (BigInt(result.position.committed) > 0n) commitmentIds.add(id);
        }
        return result.summary;
      } catch { return null; }
    })());
    return escrowFills.get(id);
  };
  const readPool = async id => {
    const pool = await readSaved(OPEN_FUNDING_SUMMARIES, id);
    return pool?.problemId === id && same(pool.owner, uid) ? pool : fillPool(id);
  };
  for (const doc of owned.docs.slice(0, CAP)) {
    const data = doc.data();
    if (data.opportunityType !== "open-funding") continue;
    let pool = null, poolUnavailable = false;
    if (supportsOpenFunding(config) && /^0x[0-9a-f]{64}$/i.test(data.audit?.transactionHash || "")) {
      pool = await readPool(doc.id);
      if (!pool) { unavailablePools++; poolUnavailable = true; }
    }
    opportunities.push({ id: doc.id, title: data.title || "Open funding", recordStatus: data.status,
      status: pool?.withdrawn ? "cancelled" : pool?.closed ? "expired" : data.status, amount: data.amount ?? 0,
      currency: data.currency || "", createdAt: iso(data.createdAt), updatedAt: iso(data.updatedAt), pool, poolUnavailable,
      grantSupported: supportsOpenFunding(config) });
  }
  const poolsByProblem = new Map(opportunities.map(item => [item.id, item.pool]));
  const approaches = [], decisions = [];
  let unavailableDecisions = 0;
  for (const doc of approachesPage.docs.slice(0, APPROACH_CAP)) {
    const data = doc.data();
    if (isIndependentProposal(data) || data.status === "draft" || hidden(data)) continue;
    let parent = ownedById.get(data.problemId);
    if (!parent) {
      const snap = await db.collection("problems").doc(data.problemId).get();
      if (!snap.exists || !same(snap.data().ownerId, uid)) continue;
      parent = snap.data();
    }
    const row = { proposalId: doc.id, problemId: data.problemId, title: data.title || "Proposal", researcherId: data.researcherId,
      postingTitle: parent.title || "Posting", opportunityType: parent.opportunityType || "business-problem", amount: data.amount ?? 0,
      currency: data.currency || "", status: data.status, recordStatus: data.status, createdAt: iso(data.createdAt) };
    const review = await db.collection(`proposals/${doc.id}/ownerReviewLatest`).doc("current").get();
    const ownerReview = ownerReviewSummary(review.data());
    approaches.push(row);
    let selection = parent.opportunityType === "open-funding" ? null
      : parent.acceptedProposalId === doc.id || data.status === "accepted" ? { status: "accepted" }
        : parent.escrowSelection?.proposalId === doc.id ? { status: "pending", requestedAt: iso(parent.escrowSelection.requestedAt) } : null;
    if (parent.opportunityType !== "open-funding" && data.fundingTerms && data.audit?.status === "confirmed") {
      let summary = await readSaved(FUNDING_SUMMARIES, doc.id);
      if (!summary) summary = await fillEscrow(doc.id);
      if (summary?.proposalId === doc.id && summary.problemId === data.problemId && WORKFLOW[summary.state]
          && same(summary.postingOwnerId, uid)) {
        const escrow = { state: summary.state, workflowStatus: WORKFLOW[summary.state], blockNumber: summary.blockNumber };
        row.escrow = escrow;
        selection = escrow.state === "Open"
          ? parent.escrowSelection?.proposalId === doc.id ? { status: "pending", requestedAt: iso(parent.escrowSelection.requestedAt) } : null
          : { status: ["Active", "Released"].includes(escrow.state) ? "accepted"
            : escrow.state === "Locked" ? "pending" : escrow.state.toLowerCase(), escrowState: escrow.state };
      } else {
        row.escrowUnavailable = true;
        selection = null;
        unavailableDecisions++;
      }
    }
    // Read a saved pool even when its posting falls outside the listing page.
    if (parent.opportunityType === "open-funding" && !poolsByProblem.has(data.problemId)) {
      const pool = supportsOpenFunding(config) ? await readPool(data.problemId) : null;
      if (!pool && supportsOpenFunding(config)) unavailablePools++;
      poolsByProblem.set(data.problemId, pool);
    }
    const pool = poolsByProblem.get(data.problemId);
    let grantAccepted = false;
    if (parent.opportunityType === "open-funding" && data.audit?.status === "confirmed" && data.fundingTerms && supportsOpenFunding(config)) {
      let offer = pool?.exists ? await readSaved(OPEN_FUNDING_SELECTIONS, doc.id) : null;
      if (pool?.exists && !offer) {
        await fillPool(data.problemId, doc.id);
        offer = await readSaved(OPEN_FUNDING_SELECTIONS, doc.id);
      }
      if (offer?.proposalId === doc.id && offer.problemId === data.problemId && same(offer.owner, uid)
          && ["none", "pending", "expired", "accepted", "voided"].includes(offer.status)) {
        if (offer.status !== "none") selection = { status: offer.status, amountBaseUnits: offer.amountBaseUnits, acceptanceDeadline: offer.acceptanceDeadline };
        grantAccepted = offer.status === "accepted";
      } else if (!pool || pool.exists) {
        unavailableDecisions++;
        selection = null;
      }
    }
    if (ownerReview || selection || (parent.opportunityType !== "open-funding" && parent.acceptedProposalId === doc.id)) {
      decisions.push({ ...row, ownerReview, selection });
    }
    // Accepted grant escrows credit the owner's wallet, even if the escrow
    // event index has not yet ingested the acceptance transaction.
    // Prospective or pending offers have no escrow commitment. Including them
    // in this bounded candidate set can crowd actual accepted grants out.
    if (grantAccepted || (parent.opportunityType === "open-funding" && !pool && data.status === "accepted"
        && data.fundingTerms && data.audit?.status === "confirmed")) commitmentIds.add(doc.id);
  }
  const commitments = [], totals = new Map();
  let unavailableCommitments = 0;
  const ids = [...commitmentIds].slice(0, CAP);
  for (const proposalId of ids) {
    let context;
    try { context = await loadFundingContext({ db, uid, proposalId }); }
    catch { continue; }
    if (isIndependentProposal(context.record)) continue;
    if (!await canReadContent({ get: ref => ref.get() }, db, "proposal", context.record, uid, profile.data())) continue;
    try {
      let snapshot = positions.get(proposalId);
      const aggregate = await readSaved(FUNDING_SUMMARIES, proposalId);
      if (!snapshot || (aggregate && aggregate.blockNumber > snapshot.blockNumber
          && fundingAllocationBasis(aggregate) !== fundingAllocationBasis(snapshot))) {
        const refreshed = await fillEscrow(proposalId);
        snapshot = refreshed ? positions.get(proposalId) : null;
      }
      if (!snapshot || snapshot.proposalId !== proposalId || snapshot.problemId !== context.parent.id
          || !WORKFLOW[snapshot.state] || !address(snapshot.escrowAddress) || !address(snapshot.tokenAddress)
          || !Number.isInteger(snapshot.tokenDecimals) || snapshot.tokenDecimals < 0 || snapshot.tokenDecimals > 77
          || ![snapshot.committed, snapshot.refunded, snapshot.released, snapshot.fundingTarget, snapshot.totalDeposited].every(units)) {
        throw new Error("Confirmed wallet snapshot unavailable");
      }
      const committed = BigInt(snapshot.committed), refunded = BigInt(snapshot.refunded), released = BigInt(snapshot.released);
      if (!committed) continue;
      const locked = committed - refunded - released;
      if (locked < 0n || committed > BigInt(snapshot.totalDeposited)) throw new Error("Commitment accounting mismatch");
      const row = { proposalId, problemId: context.parent.id, title: snapshot.title || context.record.title,
        postingTitle: snapshot.postingTitle || context.parent.title, state: snapshot.state,
        escrowAddress: snapshot.escrowAddress, chainId: snapshot.chainId, tokenAddress: snapshot.tokenAddress.toLowerCase(),
        tokenSymbol: snapshot.tokenSymbol, tokenDecimals: snapshot.tokenDecimals, blockNumber: snapshot.blockNumber,
        fundingTarget: snapshot.fundingTarget, totalDeposited: snapshot.totalDeposited,
        committed: committed.toString(), locked: locked.toString(), released: released.toString(), refunded: refunded.toString() };
      commitments.push(row);
      const key = `${row.chainId}_${row.tokenAddress}`, old = totals.get(key) || { chainId: row.chainId, tokenAddress: row.tokenAddress,
        tokenSymbol: row.tokenSymbol, tokenDecimals: row.tokenDecimals, committed: 0n, locked: 0n, released: 0n, refunded: 0n };
      old.committed += committed; old.locked += locked; old.released += released; old.refunded += refunded; totals.set(key, old);
    } catch { unavailableCommitments++; }
  }
  opportunities.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
  approaches.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  // Independent crowdfunding retains separate custody and accounting totals.
  const independent = config.independentFunding?.enabled
    ? await readIndependentFundingPortfolio({ db, config, uid, now }) : { items: [], truncated: false };
  return { opportunities, commitments, approaches, decisions,
    independentCommitments: independent.items, independentCommitmentsTruncated: independent.truncated,
    totals: [...totals.values()].map(row => ({ ...row, committed: row.committed.toString(), locked: row.locked.toString(),
      released: row.released.toString(), refunded: row.refunded.toString() })),
    truncated: { opportunities: owned.size > CAP, commitments: commitmentIds.size > CAP || deposits.size > APPROACH_CAP || positionsPage.size > APPROACH_CAP || approachesPage.size > APPROACH_CAP,
      approaches: approachesPage.size > APPROACH_CAP, decisions: approachesPage.size > APPROACH_CAP },
    totalsPartial: unavailableCommitments > 0 || unavailablePools > 0 || unavailableDecisions > 0 || commitmentIds.size > CAP || deposits.size > APPROACH_CAP || positionsPage.size > APPROACH_CAP || approachesPage.size > APPROACH_CAP,
    unavailableCommitments, unavailablePools, unavailableDecisions, blockNumber: null,
    updatedAt: now.toDate().toISOString() };
}
