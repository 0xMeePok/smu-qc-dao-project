import { createHash } from "node:crypto";
import { HttpsError } from "firebase-functions/v2/https";
import { Timestamp } from "firebase-admin/firestore";

export const CONFIRMATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PROPOSALS = 200;
const MAX_CONTRIBUTIONS = 200;
const ELIGIBLE = new Set(["submitted", "under_review"]);
const TERMINAL = new Set(["confirmed", "voided", "declined", "cancelled", "invalidated"]);
const FUNDING_EVENTS = new Set(["funding_contributed", "funding_target_reached"]);
const fail = (code, message) => { throw new HttpsError(code, message); };
const millis = (value) => value?.toMillis?.() ?? 0;
const iso = (value) => value?.toDate?.().toISOString() ?? null;
function validId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail("invalid-argument", `Invalid ${name}.`);
}
const moderated = (data) => data?.moderated || ["hidden", "removed"].includes(data?.moderationStatus);
function explanation(value, field) {
  if (typeof value !== "string" || value.trim().length < 10 || value.trim().length > 2000) {
    fail("invalid-argument", `${field} must contain 10–2000 characters.`);
  }
  return value.trim();
}
function event(tx, ctx, { type, proposalId, actorId = "system", reason = null, now, key, details = {} }) {
  const id = createHash("sha256").update(`${ctx.ref.id}:${type}:${key}`).digest("hex");
  tx.create(ctx.events.doc(id), { problemId: ctx.ref.id, proposalId: proposalId || null, type, actorId, reason,
    createdAt: now, mode: "mock", chainStatus: "not_applicable", id,
    actorRole: actorId === "system" ? "system" : ctx.problem.ownerId === actorId ? "problem_owner"
      : ctx.isAdmin ? "admin" : ctx.proposals.some(doc => doc.data().researcherId === actorId) ? "proposal_creator" : "member",
    actorWallet: /^0x[0-9a-f]{40}$/i.test(actorId) ? actorId : null, ...details });
}
function minorUnits(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.round(value * 100) < 1 || value > 1_000_000_000
      || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) {
    fail("invalid-argument", "Enter a positive mock amount with at most two decimal places.");
  }
  return Math.round(value * 100);
}
const proposalState = (proposal) => proposal.matching?.status || "funding";
const publicMatch = (matching = {}, problem = {}) => {
  const capped = matching.status === "awaiting_confirmation" && millis(problem.expiresAt) > 0
    && millis(problem.expiresAt) < millis(matching.deadlineAt);
  return { status: matching.status || "open", proposalId: matching.proposalId || null,
  deadlineAt: iso(capped ? problem.expiresAt : matching.deadlineAt), totalFundedMinor: matching.totalFundedMinor || 0,
  selectedBy: matching.selectedBy || null, selectedAt: iso(matching.selectedAt),
  ownerApprovedBy: matching.ownerApprovedBy || null, ownerApprovedAt: iso(matching.ownerApprovedAt),
  creatorApprovedBy: matching.creatorApprovedBy || null, creatorApprovedAt: iso(matching.creatorApprovedAt),
  rationale: matching.rationale || null, postingExpiresAt: iso(problem.expiresAt),
  deadlineLimitedByPosting: capped || matching.deadlineLimitedByPosting === true,
  invalidatedAt: iso(matching.invalidatedAt), invalidationReason: matching.invalidationReason || null,
  reopenedAt: iso(matching.reopenedAt), reopenReason: matching.reopenReason || null };
};
function contributionView(doc) {
  const data = doc.data();
  return { id: doc.id, problemId: data.problemId, proposalId: data.proposalId, title: data.title,
    amount: data.amount, currency: data.currency, status: data.status, refundReason: data.refundReason || null,
    createdAt: iso(data.createdAt), settledAt: iso(data.settledAt) };
}

function historyView(doc, isAdmin) {
  const data = doc.data();
  // Funding identities belong to the private ledger and administrator audit.
  // Project safe fields instead of spreading internal metadata into member views.
  const visible = !isAdmin && FUNDING_EVENTS.has(data.type)
    ? { problemId: data.problemId, proposalId: data.proposalId, type: data.type,
      actorId: null, reason: null, mode: data.mode, chainStatus: data.chainStatus }
    : data;
  return { ...visible, id: doc.id, createdAt: iso(data.createdAt), deadlineAt: iso(data.deadlineAt), postingExpiresAt: iso(data.postingExpiresAt),
    ...(data.ownerApprovedAt ? { ownerApprovedAt: iso(data.ownerApprovedAt) } : {}) };
}

// Every mutation reads and writes the parent. Concurrent selection, funding and
// expiry therefore conflict and retry against the same authoritative state.
// Hard caps keep a complete atomic settlement below Firestore's 500-write limit.
// A contended transaction can be aborted while its reads are still in flight;
// the late read returns INVALID_ARGUMENT, which the SDK never retries.
const CLOSED_TRANSACTION = /Transaction is invalid or closed/i;
async function runContendedTransaction(db, body, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.runTransaction(body);
    } catch (error) {
      if (attempt >= attempts || !CLOSED_TRANSACTION.test(String(error?.message ?? ""))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.floor(Math.random() * 25)));
    }
  }
}

async function readContext({ db, tx, problemId, uid, proposalId, cursor }) {
  const ref = db.collection("problems").doc(problemId);
  let candidateQuery = db.collection("proposals").where("problemId", "==", problemId)
    .where("status", "in", ["submitted", "under_review", "accepted", "rejected", "withdrawn"]).orderBy("__name__");
  if (cursor) candidateQuery = candidateQuery.startAfter(cursor);
  const [problem, proposals, funding, profile] = await Promise.all([
    tx.get(ref), tx.get(candidateQuery.limit(MAX_PROPOSALS + 1)),
    tx.get(db.collection("mockFunding").where("problemId", "==", problemId).limit(MAX_CONTRIBUTIONS + 1)),
    uid ? tx.get(db.collection("users").doc(uid)) : Promise.resolve(null),
  ]);
  if (uid && (!profile?.exists || profile.data().suspended)) fail("permission-denied", "Complete your active member profile first.");
  if (!problem.exists) fail("not-found", "Problem not found.");
  if (uid && moderated(problem.data())) fail("permission-denied", "This problem is under moderation.");
  if (uid && problem.data().ownerId !== uid && !["submitted", "open", "cancelled", "expired"].includes(problem.data().status)) {
    fail("permission-denied", "This problem is not available.");
  }
  if (funding.size > MAX_CONTRIBUTIONS) {
    fail("resource-exhausted", "This problem exceeds the mock settlement limit. Contact an administrator.");
  }
  // New submissions cannot prevent settlement of previously funded proposals.
  // Candidate reads are bounded; always include every ledger-referenced proposal.
  const candidates = proposals.docs.slice(0, MAX_PROPOSALS);
  const candidateIds = new Set(candidates.map((doc) => doc.id));
  const missingIds = [...new Set([...funding.docs.map((doc) => doc.data().proposalId), proposalId].filter(Boolean))].filter((id) => !candidateIds.has(id));
  const fundedProposals = await Promise.all(missingIds.map((id) => tx.get(db.collection("proposals").doc(id))));
  return { ref, events: db.collection("matchingEvents"), isAdmin: profile?.data()?.role === 1, problem: problem.data(), proposals: [...candidates, ...fundedProposals.filter((doc) => doc.exists && doc.data().problemId === problemId)],
    funding: funding.docs, truncated: proposals.size > MAX_PROPOSALS,
    nextCursor: proposals.size > MAX_PROPOSALS ? candidates.at(-1).id : null };
}
function updateProposal(tx, doc, status, now, extra = {}) {
  const data = doc.data();
  const matching = { mode: "mock", fundedMinor: 0, fundedAmount: 0, ...data.matching, status, updatedAt: now, ...extra };
  tx.update(doc.ref, { matching });
  return { ...data, matching };
}
function settleFunding(tx, funding, winnerId, now, reason) {
  for (const doc of funding) {
    const data = doc.data();
    if (data.status !== "pledged") continue;
    const locked = data.proposalId === winnerId;
    tx.update(doc.ref, { status: locked ? "locked" : "refunded", settledAt: now,
      refundReason: locked ? null : reason });
  }
}
function closeSelected(tx, ctx, now, { status = "voided", reason = "confirmation_expired", type = "confirmation_expired", actorId = "system", details = null } = {}) {
  const current = ctx.problem.matching;
  const chosen = ctx.proposals.find((doc) => doc.id === current.proposalId);
  if (chosen) updateProposal(tx, chosen, status, now, { closedAt: now, closedBy: actorId, closeReason: details || reason });
  const refundedMinor = ctx.funding.filter((doc) => doc.data().proposalId === current.proposalId && doc.data().status === "pledged")
    .reduce((total, doc) => total + doc.data().amountMinor, 0);
  settleFunding(tx, ctx.funding.filter((doc) => doc.data().proposalId === current.proposalId), null, now, reason);
  tx.update(ctx.ref, { matching: { ...current, status: "open", proposalId: null, deadlineAt: null,
    selectedBy: null, selectedAt: null,
    ownerApprovedBy: null, ownerApprovedAt: null, creatorApprovedBy: null, creatorApprovedAt: null, rationale: null,
    deadlineLimitedByPosting: false, reopenedAt: now, reopenReason: details || reason,
    totalFundedMinor: Math.max(0, (current.totalFundedMinor || 0) - refundedMinor), updatedAt: now } });
  event(tx, ctx, { type, proposalId: current.proposalId, actorId, reason: details || reason, now,
    key: current.selectionId || current.proposalId, details: { refundedAmount: refundedMinor / 100, deadlineAt: current.deadlineAt || null } });
  event(tx, ctx, { type: "posting_reopened", proposalId: current.proposalId, actorId, reason: details || reason, now,
    key: current.selectionId || current.proposalId, details: { postingExpiresAt: ctx.problem.expiresAt || null } });
}
// This is the future escrow/refund adapter boundary: the mock ledger settles
// atomically here, with immutable off-chain receipts for every invalidation.
function invalidateContext(tx, ctx, now, { actorId = "system", type = "confirmation_expired", reason = type } = {}) {
  const current = ctx.problem.matching || {};
  for (const doc of ctx.proposals) {
    if (!TERMINAL.has(proposalState(doc.data())) && (doc.id === current.proposalId || (doc.data().matching?.fundedMinor || 0) > 0)) updateProposal(tx, doc,
      doc.id === current.proposalId ? "voided" : "cancelled", now, { closedAt: now, closedBy: actorId, closeReason: reason });
  }
  const refundedMinor = ctx.funding.filter(doc => doc.data().status === "pledged")
    .reduce((total, doc) => total + doc.data().amountMinor, 0);
  settleFunding(tx, ctx.funding, null, now, reason);
  tx.update(ctx.ref, { matching: { ...current, mode: "mock", status: "invalidated", deadlineAt: null,
    totalFundedMinor: 0, invalidatedAt: now, invalidationReason: reason, updatedAt: now } });
  const receipt = { proposalId: current.proposalId, actorId, reason, now,
    key: current.selectionId || "posting_expiry", details: { refundedAmount: refundedMinor / 100,
      deadlineAt: current.deadlineAt || null, postingExpiresAt: ctx.problem.expiresAt || null } };
  event(tx, ctx, { ...receipt, type });
  event(tx, ctx, { ...receipt, type: "posting_invalidated" });
}
function expireContext(tx, ctx, now) {
  const current = ctx.problem.matching;
  if (current?.status === "confirmed" || current?.status === "invalidated") return false;
  const postingExpired = millis(ctx.problem.expiresAt) > 0 && millis(ctx.problem.expiresAt) <= now.toMillis();
  const confirmationExpired = current?.status === "awaiting_confirmation" && millis(current.deadlineAt) <= now.toMillis();
  // Legacy posting expiry is handled by its existing lifecycle. A callable may
  // refuse it without manufacturing mock records for an untouched posting.
  if (!confirmationExpired && !(postingExpired && current?.mode === "mock")) return false;
  invalidateContext(tx, ctx, now, { type: confirmationExpired ? "confirmation_expired" : "posting_expired" });
  return true;
}

export async function settleExpiredMockMatch({ db, problemId, now }) {
  validId(problemId, "problem");
  return runContendedTransaction(db, async (tx) => expireContext(tx, await readContext({ db, tx, problemId }), now || Timestamp.now()));
}

export async function sweepExpiredMockMatches({ db, now }) {
  const at = now || Timestamp.now();
  const [windows, postings] = await Promise.all([
    db.collection("problems").where("matching.deadlineAt", "<=", at).limit(100).get(),
    db.collection("problems").where("matching.mode", "==", "mock").where("matching.status", "in", ["open", "awaiting_confirmation"])
      .where("expiresAt", "<=", at).limit(100).get(),
  ]);
  let settled = 0;
  for (const problemId of new Set([...windows.docs, ...postings.docs].map(doc => doc.id))) {
    if (await settleExpiredMockMatch({ db, problemId: problemId, now: at })) settled += 1;
  }
  return { settled };
}

// Expiry commits separately, before any action validation that may throw. A late
// confirmation must not roll back the refunds when it is rejected.
async function prepare({ db, problemId, uid, now }) {
  validId(problemId, "problem");
  if (!uid) fail("unauthenticated", "Sign in with your wallet.");
  await runContendedTransaction(db, async (tx) => expireContext(tx, await readContext({ db, tx, problemId, uid }), now || Timestamp.now()));
}

export function mockSelectionState({ problem, proposal, uid, at = Timestamp.now() }) {
  const parentStatus = problem.matching?.status || "open";
  const ownStatus = proposal.matching?.status || "funding";
  const state = ["confirmed", "invalidated"].includes(parentStatus) && problem.matching?.proposalId !== proposal.id && !TERMINAL.has(ownStatus)
    ? "cancelled" : ownStatus;
  const target = Math.round(Number(proposal.amount) * 100);
  const funded = proposal.matching?.fundedMinor || 0;
  const eligible = ELIGIBLE.has(proposal.status) && !TERMINAL.has(state);
  const fundingMet = target > 0 && funded >= target;
  const feedbackOpen = proposal.matching?.evaluationComplete === true;
  const open = isOpen(problem, at);
  return {
    state, fundedAmount: funded / 100, open, eligible, fundingMet, feedbackOpen,
    canSelect: open && eligible && fundingMet && feedbackOpen && problem.ownerId === uid
      && proposal.researcherId !== uid && !moderated(proposal),
  };
}

export async function getMockMatching({ db, uid, problemId, proposalId, cursor, now }) {
  if (proposalId) validId(proposalId, "proposal");
  if (cursor) validId(cursor, "cursor");
  await prepare({ db, uid, problemId, now });
  return runContendedTransaction(db, async (tx) => {
    const ctx = await readContext({ db, tx, problemId, uid, proposalId, cursor });
    const history = await tx.get(db.collection("matchingEvents").where("problemId", "==", problemId).orderBy("createdAt", "desc").limit(101));
    const at = now || Timestamp.now();
    const matching = publicMatch(ctx.problem.matching, ctx.problem);
    const open = isOpen(ctx.problem, at);
    return { problemId, mode: "mock", matching,
      canForceExpire: ctx.isAdmin && matching.status === "awaiting_confirmation",
      history: history.docs.slice(0, 100).map(doc => historyView(doc, ctx.isAdmin)),
      historyTruncated: history.size > 100, truncated: ctx.truncated, nextCursor: ctx.nextCursor,
      proposals: ctx.proposals.filter((doc) => !moderated(doc.data()) && (ELIGIBLE.has(doc.data().status) || doc.data().matching)).map((doc) => {
        const proposal = doc.data();
        const selection = mockSelectionState({ problem: ctx.problem, proposal: { id: doc.id, ...proposal }, uid, at });
        const state = selection.state;
        const target = Math.round(Number(proposal.amount) * 100);
        const funded = proposal.matching?.fundedMinor || 0;
        const eligible = selection.eligible;
        return { id: doc.id, title: proposal.title || "Untitled proposal", currency: proposal.currency,
          amount: proposal.amount, fundedAmount: funded / 100, matching: { status: state, evaluationComplete: proposal.matching?.evaluationComplete === true,
            evaluationCompletedAt: iso(proposal.matching?.evaluationCompletedAt) },
          canCompleteEvaluation: ctx.isAdmin && open && eligible && !proposal.matching?.evaluationComplete,
          canDecline: matching.status === "awaiting_confirmation" && matching.proposalId === doc.id
            && millis(ctx.problem.matching.deadlineAt) > at.toMillis() && (proposal.researcherId === uid || ctx.problem.ownerId === uid),
          canFund: open && eligible && funded < target && proposal.researcherId !== uid && ctx.funding.length < MAX_CONTRIBUTIONS,
          canSelect: selection.canSelect,
          canApproveOwner: matching.status === "awaiting_confirmation" && matching.proposalId === doc.id
            && millis(ctx.problem.matching.deadlineAt) > at.toMillis() && ctx.problem.ownerId === uid
            && proposal.researcherId !== uid && !matching.ownerApprovedBy,
          canConfirm: matching.status === "awaiting_confirmation" && matching.proposalId === doc.id
            && millis(ctx.problem.matching.deadlineAt) > at.toMillis() && proposal.researcherId === uid
            && ctx.problem.ownerId !== uid && !matching.creatorApprovedBy };
      }), contributions: ctx.funding.filter((doc) => doc.data().funderId === uid).map(contributionView) };
  });
}

export async function fundMockProposal({ db, uid, problemId, proposalId, amount, requestId, now }) {
  validId(proposalId, "proposal");
  if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(requestId)) fail("invalid-argument", "A unique funding request ID is required.");
  const amountMinor = minorUnits(amount);
  await prepare({ db, uid, problemId, now });
  const id = createHash("sha256").update(`${uid}:${requestId}`).digest("hex");
  const result = await runContendedTransaction(db, async (tx) => {
    const ref = db.collection("mockFunding").doc(id);
    const [ctx, previous] = await Promise.all([readContext({ db, tx, problemId, uid, proposalId }), tx.get(ref)]);
    const at = now || Timestamp.now();
    if (previous.exists) {
      const value = previous.data();
      if (value.problemId !== problemId || value.proposalId !== proposalId || value.amountMinor !== amountMinor) {
        fail("already-exists", "This funding request ID was already used for a different contribution.");
      }
      return { ok: true, contributionId: id };
    }
    if (expireContext(tx, ctx, at)) return { expired: true };
    const proposal = ctx.proposals.find((doc) => doc.id === proposalId);
    if (!proposal) fail("not-found", "Proposal not found on this problem.");
    const data = proposal.data();
    if (moderated(data)) fail("failed-precondition", "This proposal is under moderation.");
    if (data.researcherId === uid) fail("permission-denied", "You cannot fund your own proposal.");
    assertOpen(ctx.problem, at);
    if (!ELIGIBLE.has(data.status) || proposalState(data) !== "funding") fail("failed-precondition", "This proposal is not accepting funding.");
    if (data.currency !== ctx.problem.currency) fail("failed-precondition", "Proposal and problem currencies must match.");
    const target = minorUnits(data.amount), fundedMinor = data.matching?.fundedMinor || 0;
    if (amountMinor > target - fundedMinor) fail("failed-precondition", "The contribution exceeds this proposal's remaining target.");
    if (ctx.funding.length >= MAX_CONTRIBUTIONS) fail("resource-exhausted", "This problem has reached the mock contribution limit.");
    tx.set(ref, { mode: "mock", funderId: uid, problemId, proposalId, title: data.title || "Untitled proposal", amount,
      amountMinor, currency: data.currency, status: "pledged", requestId, createdAt: at, settledAt: null, refundReason: null });
    tx.update(proposal.ref, { matching: { ...data.matching, mode: "mock", status: "funding", fundedMinor: fundedMinor + amountMinor,
      fundedAmount: (fundedMinor + amountMinor) / 100, updatedAt: at } });
    tx.update(ctx.ref, { matching: { mode: "mock", status: "open", proposalId: null, deadlineAt: null,
      ...ctx.problem.matching, totalFundedMinor: (ctx.problem.matching?.totalFundedMinor || 0) + amountMinor, updatedAt: at } });
    event(tx, ctx, { type: fundedMinor + amountMinor === target ? "funding_target_reached" : "funding_contributed",
      proposalId, actorId: uid, now: at, key: id });
    return { ok: true, contributionId: id };
  });
  if (result.expired) fail("failed-precondition", "The confirmation window expired. Its funding has been refunded; refresh and retry.");
  return result;
}
function isOpen(problem, at) {
  return (problem.matching?.status || "open") === "open" && ["submitted", "open"].includes(problem.status)
    && (!millis(problem.expiresAt) || millis(problem.expiresAt) > at.toMillis())
    && !problem.acceptedProposalId && !problem.acceptedSolutionId
    && !problem.hasAcceptedSolution && !problem.moderated && !["hidden", "removed"].includes(problem.moderationStatus);
}
function assertOpen(problem, at) {
  if ((problem.matching?.status || "open") !== "open") fail("failed-precondition", "This problem is no longer open for funding or selection.");
  if (!isOpen(problem, at)) {
    fail("failed-precondition", "This problem is no longer open for funding or selection.");
  }
}

export async function selectMockProposal({ db, uid, problemId, proposalId, rationale, now }) {
  rationale = explanation(rationale, "Selection rationale");
  validId(proposalId, "proposal");
  await prepare({ db, uid, problemId, now });
  const result = await runContendedTransaction(db, async (tx) => {
    const ctx = await readContext({ db, tx, problemId, uid, proposalId });
    const at = now || Timestamp.now();
    if (ctx.problem.ownerId !== uid) fail("permission-denied", "Only the problem owner can select a proposal.");
    if (expireContext(tx, ctx, at)) return { expired: true };
    if (["awaiting_confirmation", "confirmed"].includes(ctx.problem.matching?.status) && ctx.problem.matching.proposalId === proposalId) return { ok: true };
    assertOpen(ctx.problem, at);
    const chosen = ctx.proposals.find((doc) => doc.id === proposalId);
    if (!chosen) fail("not-found", "Proposal not found on this problem.");
    const data = chosen.data();
    if (moderated(data)) fail("failed-precondition", "This proposal is under moderation.");
    if (data.researcherId === uid) fail("permission-denied", "A match requires two different parties.");
    if (!ELIGIBLE.has(data.status) || proposalState(data) !== "funding" || (data.matching?.fundedMinor || 0) < minorUnits(data.amount)) {
      fail("failed-precondition", "Select a fully funded, active proposal.");
    }
    if (data.matching?.evaluationComplete !== true) {
      fail("failed-precondition", "Selection opens after the evaluator feedback gate and full funding.");
    }
    const selectionSequence = (ctx.problem.matching?.selectionSequence || 0) + 1;
    const selectionId = `${problemId}_${selectionSequence}`;
    const deadlineMs = Math.min(at.toMillis() + CONFIRMATION_WINDOW_MS, millis(ctx.problem.expiresAt) || Infinity);
    const deadlineAt = Timestamp.fromMillis(deadlineMs);
    const deadlineLimitedByPosting = deadlineMs < at.toMillis() + CONFIRMATION_WINDOW_MS;
    updateProposal(tx, chosen, "awaiting_confirmation", at, { deadlineAt, deadlineLimitedByPosting, selectedBy: uid, selectedAt: at,
      ownerApprovedBy: uid, ownerApprovedAt: at, creatorApprovedBy: null, creatorApprovedAt: null, rationale, selectionId });
    event(tx, ctx, { type: "owner_selected", proposalId, actorId: uid, reason: rationale, now: at, key: selectionId,
      details: { evaluationComplete: data.matching?.evaluationComplete === true, fundedAmount: data.matching.fundedMinor / 100, targetAmount: data.amount,
        ownerApprovedBy: uid, ownerApprovedAt: at,
        deadlineAt, deadlineLimitedByPosting } });
    tx.update(ctx.ref, { matching: { ...ctx.problem.matching, mode: "mock", status: "awaiting_confirmation", proposalId, selectionId, selectionSequence,
      ownerApprovedBy: uid, ownerApprovedAt: at, creatorApprovedBy: null, creatorApprovedAt: null, rationale,
      deadlineAt, deadlineLimitedByPosting, selectedBy: uid, selectedAt: at, updatedAt: at } });
    return { ok: true };
  });
  if (result.expired) fail("failed-precondition", "The confirmation window expired. Its funding has been refunded; refresh and retry.");
  return result;
}

export async function confirmMockProposal({ db, uid, problemId, proposalId, now }) {
  validId(proposalId, "proposal");
  await prepare({ db, uid, problemId, now });
  const result = await runContendedTransaction(db, async (tx) => {
    const ctx = await readContext({ db, tx, problemId, uid, proposalId });
    const at = now || Timestamp.now();
    const chosen = ctx.proposals.find((doc) => doc.id === proposalId);
    const owner = ctx.problem.ownerId === uid;
    const creator = chosen?.data().researcherId === uid;
    if (!chosen || (!owner && !creator) || (owner && creator)) fail("permission-denied", "Only the problem owner and selected proposal's creator can accept this match.");
    if (expireContext(tx, ctx, at)) return { expired: true };
    if (moderated(chosen.data())) fail("failed-precondition", "This proposal is under moderation.");
    const matching = ctx.problem.matching;
    if (matching?.status === "confirmed" && matching.proposalId === proposalId) return { ok: true };
    if (matching?.status !== "awaiting_confirmation" || matching.proposalId !== proposalId || millis(matching.deadlineAt) <= at.toMillis()) {
      fail("failed-precondition", "This proposal has no active confirmation window.");
    }
    const approvalField = owner ? "ownerApprovedBy" : "creatorApprovedBy";
    if (matching[approvalField]) return { ok: true };
    const approvals = owner ? { ownerApprovedBy: uid, ownerApprovedAt: at } : { creatorApprovedBy: uid, creatorApprovedAt: at };
    const accepted = { ...matching, ...approvals };
    event(tx, ctx, { type: owner ? "owner_confirmed" : "creator_confirmed", proposalId, actorId: uid, now: at,
      key: matching.selectionId || proposalId, details: { deadlineAt: matching.deadlineAt } });
    if (!accepted.ownerApprovedBy || !accepted.creatorApprovedBy) {
      updateProposal(tx, chosen, "awaiting_confirmation", at, approvals);
      tx.update(ctx.ref, { matching: { ...accepted, updatedAt: at } });
      return { ok: true };
    }
    for (const doc of ctx.proposals) {
      if (doc.id === proposalId) updateProposal(tx, doc, "confirmed", at, { ownerApprovedBy: accepted.ownerApprovedBy,
        ownerApprovedAt: accepted.ownerApprovedAt, creatorApprovedBy: accepted.creatorApprovedBy, creatorApprovedAt: accepted.creatorApprovedAt });
      else if ((doc.data().matching?.fundedMinor || 0) > 0 && !TERMINAL.has(proposalState(doc.data()))) updateProposal(tx, doc, "cancelled", at);
    }
    settleFunding(tx, ctx.funding, proposalId, at, "another_proposal_confirmed");
    tx.update(ctx.ref, { matching: { ...accepted, status: "confirmed", deadlineAt: null,
      totalFundedMinor: chosen.data().matching.fundedMinor, confirmedAt: at, updatedAt: at } });
    event(tx, ctx, { type: "match_confirmed", proposalId, actorId: uid, now: at, key: matching.selectionId || proposalId, details: { lockedAmount: chosen.data().matching.fundedMinor / 100,
      refundedAmount: ctx.funding.filter(doc => doc.data().proposalId !== proposalId && doc.data().status === "pledged")
        .reduce((total, doc) => total + doc.data().amountMinor, 0) / 100 } });
    return { ok: true };
  });
  if (result.expired) fail("failed-precondition", "The confirmation window expired. Its funding has been refunded; refresh and retry.");
  return result;
}

export async function getMockFundingPortfolio({ db, uid, now }) {
  if (!uid) fail("unauthenticated", "Sign in with your wallet.");
  const query = db.collection("mockFunding").where("funderId", "==", uid).limit(1000);
  const initial = await query.get();
  for (const problemId of new Set(initial.docs.filter((doc) => doc.data().status === "pledged").map((doc) => doc.data().problemId))) {
    await prepare({ db, uid, problemId, now });
  }
  const rows = await query.get();
  return { mode: "mock", contributions: rows.docs.map(contributionView), truncated: rows.size === 1000 };
}

export async function declineMockProposal({ db, uid, problemId, proposalId, reason, now }) {
  validId(proposalId, "proposal");
  reason = explanation(reason, "Decline reason");
  await prepare({ db, uid, problemId, now });
  const result = await runContendedTransaction(db, async (tx) => {
    const ctx = await readContext({ db, tx, problemId, uid, proposalId });
    const at = now || Timestamp.now();
    const chosen = ctx.proposals.find(doc => doc.id === proposalId);
    const owner = ctx.problem.ownerId === uid;
    if (!chosen || (!owner && chosen.data().researcherId !== uid)) fail("permission-denied", "Only the problem owner or selected proposal's creator can reject this selection.");
    if (chosen.data().matching?.status === "declined") return { ok: true };
    if (expireContext(tx, ctx, at)) return { expired: true };
    if (ctx.problem.matching?.status !== "awaiting_confirmation" || ctx.problem.matching.proposalId !== proposalId) {
      fail("failed-precondition", "This proposal has no active confirmation window.");
    }
    const type = owner ? "owner_declined" : "creator_declined";
    closeSelected(tx, ctx, at, { status: "declined", reason: type, type, actorId: uid, details: reason });
    return { ok: true };
  });
  if (result.expired) fail("failed-precondition", "The confirmation window expired and its funding was refunded.");
  return result;
}

export async function completeMockEvaluation({ db, uid, problemId, proposalId, now }) {
  validId(proposalId, "proposal");
  await prepare({ db, uid, problemId, now });
  return runContendedTransaction(db, async tx => {
    const ctx = await readContext({ db, tx, problemId, uid, proposalId });
    if (!ctx.isAdmin) fail("permission-denied", "Only an administrator can complete a mock evaluation.");
    const at = now || Timestamp.now();
    const chosen = ctx.proposals.find(doc => doc.id === proposalId);
    if (!chosen || !ELIGIBLE.has(chosen.data().status) || moderated(chosen.data())) fail("failed-precondition", "This proposal is not available for evaluation.");
    if (chosen.data().matching?.evaluationMockComplete === true) return { ok: true };
    assertOpen(ctx.problem, at);
    if (TERMINAL.has(proposalState(chosen.data()))) fail("failed-precondition", "This proposal is no longer active.");
    updateProposal(tx, chosen, proposalState(chosen.data()), at, {
      evaluationComplete: true, evaluationCompletedAt: chosen.data().matching?.evaluationCompletedAt || at,
      evaluationCompletedBy: uid, evaluationMockComplete: true,
    });
    // Also touch the parent so this gate is serialized with funding/selection.
    tx.update(ctx.ref, { matching: { mode: "mock", status: "open", proposalId: null, deadlineAt: null,
      ...ctx.problem.matching, updatedAt: at } });
    event(tx, ctx, { type: "mock_evaluation_completed", proposalId, actorId: uid, now: at, key: proposalId });
    return { ok: true };
  });
}

export async function forceExpireMockMatch({ db, uid, problemId, now }) {
  validId(problemId, "problem");
  if (!uid) fail("unauthenticated", "Sign in with your wallet.");
  return runContendedTransaction(db, async tx => {
    const ctx = await readContext({ db, tx, problemId, uid });
    if (!ctx.isAdmin) fail("permission-denied", "Only an administrator can force-expire a mock window.");
    if (ctx.problem.matching?.status !== "awaiting_confirmation") return { ok: true, expired: false };
    invalidateContext(tx, ctx, now || Timestamp.now(), { actorId: uid, type: "admin_force_expired" });
    return { ok: true, expired: true };
  });
}

/** Read first; apply() only writes, so moderation can keep one atomic transaction. */
export async function prepareModerationMatching({ tx, db, contentType, contentId, action, now, actorId }) {
  const proposalScope = ["proposal", "proposals"].includes(contentType);
  const problemScope = ["problem", "problems"].includes(contentType);
  const empty = { apply() {}, summary: { refundedAmount: 0, refundedCount: 0, currency: null } };
  if (!proposalScope && !problemScope) return empty;
  const proposal = proposalScope ? await tx.get(db.collection("proposals").doc(contentId)) : null;
  if (proposalScope && !proposal.exists) return empty;
  const problemId = proposalScope ? proposal.data().problemId : contentId;
  const ctx = await readContext({ db, tx, problemId, proposalId: proposalScope ? contentId : undefined });
  const affected = doc => !proposalScope || doc.data().proposalId === contentId;
  const refunds = ctx.funding.filter(doc => affected(doc) && doc.data().status === "pledged");
  const refundedMinor = refunds.reduce((total, doc) => total + doc.data().amountMinor, 0);
  const matching = ctx.problem.matching || {};
  const selectedAffected = matching.status === "awaiting_confirmation" && (!proposalScope || matching.proposalId === contentId);
  const at = now || Timestamp.now();
  return { summary: { refundedAmount: action === "restore" ? 0 : refundedMinor / 100,
    refundedCount: action === "restore" ? 0 : refunds.length, currency: ctx.problem.currency || null },
    apply() {
      // Storage cannot get() the parent problem (two-read cap: profile + record).
      // Stamp parent marketplace visibility onto every loaded child so proposal
      // PDFs stay aligned with submittedProposalVisibleToMembers() in firestore.rules.
      if (problemScope && ["hide", "remove", "restore"].includes(action)) {
        const problemBrowsable = action === "restore";
        for (const doc of ctx.proposals) tx.update(doc.ref, { problemBrowsable, updatedAt: at });
      }
      if (action === "restore") {
        if (matching.status === "confirmed") return;
        for (const doc of ctx.proposals) {
          if (proposalScope && doc.id !== contentId) continue;
          if (!String(doc.data().matching?.closeReason || "").startsWith("moderation_")) continue;
          updateProposal(tx, doc, "funding", at, { fundedMinor: 0, fundedAmount: 0, closeReason: null });
        }
        return;
      }
      if (!["hide", "remove"].includes(action)) return;
      settleFunding(tx, refunds, null, at, `moderation_${action}`);
      const affectedIds = new Set(refunds.map(doc => doc.data().proposalId));
      if (selectedAffected) affectedIds.add(matching.proposalId);
      for (const doc of ctx.proposals) {
        if (!affectedIds.has(doc.id)) continue;
        updateProposal(tx, doc, selectedAffected && doc.id === matching.proposalId ? "voided" : "cancelled", at,
          { closeReason: `moderation_${action}`, closedAt: at, closedBy: actorId });
      }
      if (refunds.length || selectedAffected) {
        tx.update(ctx.ref, { matching: { ...matching,
          ...(selectedAffected ? { status: "open", proposalId: null, deadlineAt: null, selectedBy: null, selectedAt: null, ownerApprovedBy: null,
            ownerApprovedAt: null, creatorApprovedBy: null, creatorApprovedAt: null, rationale: null } : {}),
          totalFundedMinor: Math.max(0, (matching.totalFundedMinor || 0) - refundedMinor), updatedAt: at } });
        event(tx, ctx, { type: "moderation_refunded", proposalId: proposalScope ? contentId : null, actorId,
          reason: `moderation_${action}`, now: at, key: `${contentId}:${action}:${at.toMillis()}` });
      }
    } };
}
