import { createHash } from "node:crypto";
import { HttpsError } from "firebase-functions/v2/https";
import { ROLE_ADMIN } from "./comments.js";
import { memberNoticeFields } from "./moderation.js";

export const OWNER_REVIEW_OUTCOMES = new Set(["feedback", "revision_requested", "not_progressing"]);
const OPEN_PROPOSAL = new Set(["submitted", "under_review"]);
const CLOSED_PROPOSAL_MATCHING = new Set(["awaiting_confirmation", "confirmed", "voided", "declined", "cancelled"]);
const BLOCKED = new Set(["hidden", "removed"]);
const REVIEW_CAP = 50;
const fail = (code, message) => { throw new HttpsError(code, message); };
const iso = (value) => value?.toDate?.().toISOString?.() ?? null;
const sameId = (left, right) => String(left || "").toLowerCase() === String(right || "").toLowerCase();

function validId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail("invalid-argument", `Invalid ${name}.`);
}

function rationaleFor(value) {
  if (typeof value !== "string" || value.trim().length < 10 || value.trim().length > 2000) {
    fail("invalid-argument", "Review rationale must contain 10–2000 characters.");
  }
  return value.trim();
}

function outcomeFor(value) {
  if (!OWNER_REVIEW_OUTCOMES.has(value)) fail("invalid-argument", "Choose feedback, request revisions, or not progressing.");
  return value;
}

export function correctionPathOpen(proposal = {}, problem = {}) {
  const matching = proposal.matching || {};
  const problemMatching = problem.matching || {};
  const funded = (matching.fundedMinor || 0) > 0 || Number(matching.fundedAmount || 0) > 0;
  return proposal.status === "submitted"
    && !funded
    && matching.evaluationComplete !== true
    && !CLOSED_PROPOSAL_MATCHING.has(matching.status || "")
    && !["awaiting_confirmation", "confirmed", "invalidated"].includes(problemMatching.status || "");
}

function reviewStillOpen(proposal, problem) {
  if (!OPEN_PROPOSAL.has(proposal.status)) return false;
  if (proposal.moderated || BLOCKED.has(proposal.moderationStatus)) return false;
  if (problem.moderated || BLOCKED.has(problem.moderationStatus)) return false;
  if ((problem.matching?.status || "open") !== "open") return false;
  return !CLOSED_PROPOSAL_MATCHING.has(proposal.matching?.status || "");
}

function reviewDocId(proposalId, requestId) {
  return createHash("sha256").update(`${proposalId}:${requestId}`).digest("hex");
}

function view(id, data) {
  return {
    id,
    proposalId: data.proposalId,
    actorId: data.actorId,
    actorRole: data.actorRole,
    outcome: data.outcome,
    rationale: data.rationale,
    createdAt: iso(data.createdAt),
    proposalStatus: data.proposalStatus,
    correctionPathOpen: data.correctionPathOpen === true,
  };
}

export function ownerReviewSummary(data) {
  if (!data?.outcome) return null;
  return {
    outcome: data.outcome,
    rationale: data.rationale ?? "",
    at: iso(data.createdAt),
    correctionPathOpen: data.correctionPathOpen === true,
    actorRole: data.actorRole ?? "problem_owner",
  };
}

const NOTICE = {
  feedback: (title) => `The problem owner recorded feedback on “${title}”.`,
  revision_requested: (title) => `The problem owner requested revisions on “${title}”.`,
  not_progressing: (title) => `The problem owner recorded that “${title}” is not progressing.`,
};

async function activeProfile(tx, db, uid) {
  if (!uid) fail("unauthenticated", "Sign in to continue.");
  const profile = await tx.get(db.collection("users").doc(uid));
  if (!profile.exists || profile.data().suspended) fail("permission-denied", "An active member profile is required.");
  return profile.data();
}

/**
 * Designated problem owner records feedback, a revision request, or that the
 * proposal is not progressing. The write never selects or rejects a winner.
 */
export async function recordOwnerReview({ db, uid, proposalId, outcome, rationale, requestId, now }) {
  validId(proposalId, "proposal");
  validId(requestId, "request");
  outcome = outcomeFor(outcome);
  rationale = rationaleFor(rationale);
  const actorId = String(uid || "").toLowerCase();
  const reviewId = reviewDocId(proposalId, requestId);
  const reviewRef = db.collection(`proposals/${proposalId}/ownerReviews`).doc(reviewId);
  const latestRef = db.collection(`proposals/${proposalId}/ownerReviewLatest`).doc("current");

  return db.runTransaction(async (tx) => {
    await activeProfile(tx, db, uid);
    const proposal = await tx.get(db.collection("proposals").doc(proposalId));
    if (!proposal.exists) fail("not-found", "Proposal not found.");
    const data = proposal.data();
    if (!data.problemId) fail("failed-precondition", "This proposal is not linked to an opportunity.");
    const problem = await tx.get(db.collection("problems").doc(data.problemId));
    if (!problem.exists) fail("not-found", "Opportunity not found.");
    const problemData = problem.data();
    if (!sameId(problemData.ownerId, actorId)) fail("permission-denied", "Only the designated problem owner can record a review.");
    if (sameId(data.researcherId, actorId)) fail("permission-denied", "The proposal author cannot review their own proposal.");
    if (!reviewStillOpen(data, problemData)) {
      fail("failed-precondition", "Owner review is closed once winner selection has started or the proposal is no longer under consideration.");
    }
    const pathOpen = correctionPathOpen(data, problemData);
    if (outcome === "revision_requested" && !pathOpen) {
      fail("failed-precondition", "Revisions can be requested only while the developer can still edit and resubmit this proposal. Record feedback instead.");
    }
    const existing = await tx.get(reviewRef);
    if (existing.exists) {
      const prior = existing.data();
      if (prior.actorId === actorId && prior.outcome === outcome && prior.rationale === rationale) return view(reviewId, prior);
      fail("already-exists", "This review was already recorded.");
    }
    const researcherId = String(data.researcherId || "").toLowerCase();
    const noticeId = `owner_review_${reviewId}_${researcherId}`;
    const noticeRef = researcherId ? db.collection("moderationNotifications").doc(noticeId) : null;
    if (noticeRef) await tx.get(noticeRef);
    const record = {
      proposalId,
      actorId,
      actorRole: "problem_owner",
      outcome,
      rationale,
      createdAt: now,
      researcherId,
      postingOwnerId: String(data.postingOwnerId || problemData.ownerId || "").toLowerCase(),
      proposalStatus: data.status,
      correctionPathOpen: pathOpen,
    };
    tx.create(reviewRef, record);
    tx.set(latestRef, record);
    if (noticeRef) {
      const title = String(data.title || "Proposal").slice(0, 160);
      tx.create(noticeRef, memberNoticeFields({
        recipientId: researcherId, now, createdAt: now, kind: "owner_review",
        contentType: "proposal", contentId: proposalId, proposalId, problemId: data.problemId, title,
        message: NOTICE[outcome](title),
      }));
    }
    return view(reviewId, record);
  });
}

/** Author, designated owner, and administrators read the append-only trail. */
export async function listOwnerReviews({ db, uid, proposalId }) {
  validId(proposalId, "proposal");
  const actorId = String(uid || "").toLowerCase();
  const profileSnap = await db.collection("users").doc(uid).get();
  if (!uid || !profileSnap.exists || profileSnap.data().suspended) fail("permission-denied", "An active member profile is required.");
  const proposal = await db.collection("proposals").doc(proposalId).get();
  if (!proposal.exists) fail("not-found", "Proposal not found.");
  const data = proposal.data();
  const problem = data.problemId ? await db.collection("problems").doc(data.problemId).get() : null;
  const ownerId = problem?.exists ? problem.data().ownerId : data.postingOwnerId;
  const allowed = sameId(data.researcherId, actorId) || sameId(ownerId, actorId) || profileSnap.data().role === ROLE_ADMIN;
  if (!allowed) fail("permission-denied", "This review record is not available.");
  const rows = await db.collection(`proposals/${proposalId}/ownerReviews`).orderBy("createdAt", "desc").limit(REVIEW_CAP).get();
  return { items: rows.docs.map((doc) => view(doc.id, doc.data())) };
}
