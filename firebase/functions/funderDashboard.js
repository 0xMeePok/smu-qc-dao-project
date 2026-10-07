import { HttpsError } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";
import { canReadContent } from "./moderation.js";
import { ownerReviewSummary } from "./ownerReviews.js";
import { FUNDING_EVENTS, loadFundingContext, readVerifiedFunding } from "./escrowFunding.js";
import { readOpenFunding, supportsOpenFunding } from "./openFunding.js";
import { same } from "./escrowFundingEvents.js";
import { prepareStoredProposal } from "./proposalAuditPayload.js";
import { isIndependentProposal } from "./independentProposal.js";
import { readEscrowQueueActions } from "./escrowQueueMetadata.js";
import { createRequestReadClient } from "./requestReadClient.js";

const CAP = 50, APPROACH_CAP = 200;
const iso = value => value?.toDate?.().toISOString?.() ?? null;
const at = (row, name, index) => row?.[name] ?? row?.[index];
const hidden = row => row?.moderated || ["hidden", "removed"].includes(row?.moderationStatus);
const fail = (code, message) => { throw new HttpsError(code, message); };

/** A removed independent listing stays claimable without exposing its body. */
async function removedIndependentClaim(db, proposalId) {
  const snap = await db.collection("proposals").doc(proposalId).get();
  if (!snap.exists) return null;
  const stored = snap.data();
  if (!isIndependentProposal(stored) || stored.moderationStatus !== "removed" || !stored.fundingTerms) return null;
  return {
    proposalId, title: String(stored.title || "Independent listing").slice(0, 160),
    postingTitle: "Independent listing", claimFunds: true, removed: true,
  };
}

/** QCDAO-94: member's opportunities, approaches and verified wallet commitments.
 * Exact token base units are grouped by chain and token; currencies never mix. */
export async function getFunderDashboard({ db, client, config, uid, now = Timestamp.now() }) {
  const profile = await db.collection("users").doc(uid).get();
  if (!profile.exists || profile.data().suspended) fail("permission-denied", "An active member profile is required.");
  client = createRequestReadClient(client, { chainId: config.chainId });
  const [owned, deposits, approachesPage] = await Promise.all([
    db.collection("problems").where("ownerId", "==", uid).where("opportunityType", "==", "open-funding").limit(CAP + 1).get(),
    db.collection(FUNDING_EVENTS).where("actor", "==", uid).where("eventType", "==", "Deposit")
      .where("registryAddress", "==", config.address.toLowerCase()).limit(APPROACH_CAP + 1).get(),
    db.collection("proposals").where("postingOwnerId", "==", uid).limit(APPROACH_CAP + 1).get(),
  ]);
  const opportunities = [], ownedById = new Map(owned.docs.map(doc => [doc.id, doc.data()]));
  let unavailablePools = 0;
  let safeBlock;
  let safeTimestamp;
  try {
    if (await client.getChainId() !== config.chainId) throw new Error("Incorrect chain");
    safeBlock = await client.getBlockNumber({ cacheTime: 0 }) - 1n;
    if (safeBlock < 0n) throw new Error("No confirmed block");
    safeTimestamp = (await client.getBlock({ blockNumber: safeBlock })).timestamp;
  } catch { /* Business records remain usable when RPC reads are unavailable. */ }
  for (const doc of owned.docs.slice(0, CAP)) {
    const data = doc.data();
    if (data.opportunityType !== "open-funding") continue;
    let pool = null, poolUnavailable = false;
    if (supportsOpenFunding(config) && /^0x[0-9a-f]{64}$/i.test(data.audit?.transactionHash || "")) {
      try {
        if (safeBlock === undefined || safeTimestamp === undefined) throw new Error("RPC unavailable");
        pool = await readOpenFunding({ db, client, config, uid, problemId: doc.id, blockNumber: safeBlock, includeSelections: false });
      }
      catch { unavailablePools++; poolUnavailable = true; }
    }
    opportunities.push({ id: doc.id, title: data.title || "Open funding", recordStatus: data.status,
      status: pool?.withdrawn ? "cancelled" : pool?.closed ? "expired" : data.status, amount: data.amount ?? 0,
      currency: data.currency || "", createdAt: iso(data.createdAt), updatedAt: iso(data.updatedAt), pool, poolUnavailable,
      grantSupported: supportsOpenFunding(config) });
  }
  const poolsByProblem = new Map(opportunities.map(item => [item.id, item.pool]));
  const approaches = [], decisions = [], commitmentIds = new Set(deposits.docs.slice(0, APPROACH_CAP)
    .filter(doc => doc.data().verified === true && doc.data().chainId === config.chainId).map(doc => doc.data().proposalId));
  let unavailableDecisions = 0;
  for (const doc of approachesPage.docs.slice(0, APPROACH_CAP)) {
    const data = doc.data();
    if (data.status === "draft" || hidden(data)) continue;
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
      const canonical = await readEscrowQueueActions({ db, client, config, uid, docs: [doc], blockNumber: safeBlock });
      const escrow = canonical.states.get(doc.id);
      if (escrow) {
        row.escrow = escrow;
        // The pending Firestore request is retained after upfront release.
        // Confirmed escrow state, rather than that request, describes the decision.
        selection = escrow.state === "Open"
          ? parent.escrowSelection?.proposalId === doc.id ? { status: "pending", requestedAt: iso(parent.escrowSelection.requestedAt) } : null
          : { status: ["Active", "Released"].includes(escrow.state) ? "accepted"
            : escrow.state === "Locked" ? "pending" : escrow.state.toLowerCase(), escrowState: escrow.state };
      } else if (canonical.unavailable.has(doc.id)) {
        row.escrowUnavailable = true;
        selection = null;
        unavailableDecisions++;
      }
    }
    // A listing page limit must not hide an accepted grant on another owned
    // posting. Read its pool once, using the same confirmed block as the page.
    if (parent.opportunityType === "open-funding" && !poolsByProblem.has(data.problemId)) {
      let pool = null;
      if (supportsOpenFunding(config) && safeBlock !== undefined && safeBlock >= 0n) {
        try { pool = await readOpenFunding({ db, client, config, uid, problemId: data.problemId, blockNumber: safeBlock, includeSelections: false }); }
        catch { unavailablePools++; }
      }
      poolsByProblem.set(data.problemId, pool);
    }
    const pool = poolsByProblem.get(data.problemId);
    let grantAccepted = false;
    if (pool?.exists && data.audit?.status === "confirmed" && data.fundingTerms) {
      try {
        const expected = prepareStoredProposal({ ...data, id: doc.id }, { registryConfig: config });
        const offer = await client.readContract({ address: pool.poolAddress, abi: config.escrow.openFundingPoolAbi,
          functionName: "getOffer", args: [expected.entityId], blockNumber: safeBlock });
        const state = Number(at(offer, "state", 2)), deadline = BigInt(at(offer, "acceptanceDeadline", 1));
        if ([1, 2, 3].includes(state)) selection = { status: state === 1 && deadline <= safeTimestamp ? "expired" : ["none", "pending", "accepted", "voided"][state],
          amountBaseUnits: String(at(offer, "amount", 0)), acceptanceDeadline: deadline.toString() };
        grantAccepted = state === 2;
      } catch { unavailableDecisions++; selection = null; }
    } else if (parent.opportunityType === "open-funding" && data.audit?.status === "confirmed" && data.fundingTerms && supportsOpenFunding(config) && !pool) {
      unavailableDecisions++;
      selection = null;
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
    catch {
      const removed = await removedIndependentClaim(db, proposalId);
      if (removed) commitments.push(removed);
      continue;
    }
    if (!await canReadContent({ get: ref => ref.get() }, db, "proposal", context.record, uid, profile.data())) continue;
    try {
      if (safeBlock === undefined || safeBlock < 0n) throw new Error("RPC unavailable");
      const verified = await readVerifiedFunding({ client, config, ...context, blockNumber: safeBlock });
      const own = await client.readContract({ address: verified.escrow.address, abi: config.escrow.escrowAbi,
        functionName: "depositorSummary", args: [uid], blockNumber: safeBlock });
      const committed = BigInt(at(own, "deposited", 0)), refunded = BigInt(at(own, "refunded", 2)), released = BigInt(at(own, "released", 4));
      if (!committed) continue;
      const locked = committed - refunded - released;
      if (locked < 0n) throw new Error("Commitment accounting mismatch");
      const { summary } = verified;
      const row = { proposalId, problemId: context.parent.id, title: summary.title, postingTitle: summary.postingTitle, state: summary.state,
        escrowAddress: summary.escrowAddress, chainId: summary.chainId, tokenAddress: summary.tokenAddress,
        tokenSymbol: summary.tokenSymbol, tokenDecimals: summary.tokenDecimals, blockNumber: Number(safeBlock),
        fundingTarget: summary.fundingTarget, totalDeposited: summary.totalDeposited,
        committed: committed.toString(), locked: locked.toString(), released: released.toString(), refunded: refunded.toString() };
      commitments.push(row);
      const key = `${row.chainId}_${row.tokenAddress}`, old = totals.get(key) || { chainId: row.chainId, tokenAddress: row.tokenAddress,
        tokenSymbol: row.tokenSymbol, tokenDecimals: row.tokenDecimals, committed: 0n, locked: 0n, released: 0n, refunded: 0n };
      old.committed += committed; old.locked += locked; old.released += released; old.refunded += refunded; totals.set(key, old);
    } catch { unavailableCommitments++; }
  }
  opportunities.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
  approaches.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  return { opportunities, commitments, approaches, decisions,
    totals: [...totals.values()].map(row => ({ ...row, committed: row.committed.toString(), locked: row.locked.toString(),
      released: row.released.toString(), refunded: row.refunded.toString() })),
    truncated: { opportunities: owned.size > CAP, commitments: commitmentIds.size > CAP || deposits.size > APPROACH_CAP || approachesPage.size > APPROACH_CAP,
      approaches: approachesPage.size > APPROACH_CAP, decisions: approachesPage.size > APPROACH_CAP },
    totalsPartial: unavailableCommitments > 0 || unavailablePools > 0 || unavailableDecisions > 0 || commitmentIds.size > CAP || deposits.size > APPROACH_CAP || approachesPage.size > APPROACH_CAP,
    unavailableCommitments, unavailablePools, unavailableDecisions, blockNumber: safeBlock !== undefined && safeBlock >= 0n ? Number(safeBlock) : null,
    updatedAt: now.toDate().toISOString() };
}
