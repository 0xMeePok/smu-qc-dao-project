import { randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { canReadContent, memberNoticeFields } from "./moderation.js";

export const ROLE_EVALUATOR = 2;
export const ROLE_ADMIN = 1;
export const COMMENT_EDIT_WINDOW_MS = 15 * 60 * 1000;
export const COMMENT_BODY_MAX = 5000;
// A thread is bounded so one discussion cannot grow into an unbounded read.
export const REPLIES_PER_THREAD = 200;
export const REPLIES_PER_MEMBER_PER_THREAD = 20;
export const EVALUATOR_BADGE = "evaluator";
export const RECOMMENDATIONS = new Set(["recommend", "recommend_with_revisions", "do_not_recommend"]);
const BLOCKED = new Set(["hidden", "removed"]);
const GRADING = { qftGrade: null, qftGradedAt: null, qftGradedBy: null };
const fail = (code, message) => { throw new HttpsError(code, message); };
const millis = (value) => value?.toMillis?.() ?? 0;
const iso = (value) => value?.toDate?.().toISOString?.() ?? null;

function validId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail("invalid-argument", `Invalid ${name}.`);
}

function commentBody(value) {
  if (typeof value !== "string") fail("invalid-argument", "Enter a comment.");
  const body = value.trim();
  if (!body) fail("invalid-argument", "Enter a comment.");
  if (body.length > COMMENT_BODY_MAX) fail("invalid-argument", `Use at most ${COMMENT_BODY_MAX} characters.`);
  return body;
}

function accessLevel(profile) {
  return profile?.role === ROLE_EVALUATOR || profile?.role === ROLE_ADMIN ? profile.role : 0;
}

function presentation(role) {
  if (role === ROLE_EVALUATOR) return { authorRole: "evaluator", badge: EVALUATOR_BADGE };
  if (role === ROLE_ADMIN) return { authorRole: "administrator", badge: null };
  return { authorRole: "user", badge: null };
}

function ownSolution(proposal, uid) {
  return proposal?.data?.().researcherId === uid;
}

/** One recommendation per solution, and never from its own author. */
function canRecommend({ proposal, uid, role, isReply, commentId = null }) {
  if (role !== ROLE_EVALUATOR || isReply || ownSolution(proposal, uid)) return false;
  const held = recommendationHolder(proposal?.data?.());
  return !held || held.commentId === commentId;
}

function assertRecommendationAllowed({ proposal, uid, recommendation, isReply, commentId = null }) {
  if (recommendation == null || recommendation === "" || isReply) return;
  if (ownSolution(proposal, uid)) {
    fail("permission-denied", "You cannot recommend your own solution.");
  }
  const held = recommendationHolder(proposal?.data?.());
  if (held && held.commentId !== commentId) {
    fail("failed-precondition", "Another evaluator has already recommended this solution.");
  }
}

function recommendationFor(role, value, previous = null, { reply = false } = {}) {
  const provided = value != null && value !== "";
  if (reply) {
    if (provided) fail("invalid-argument", "Replies cannot include a recommendation.");
    return null;
  }
  if (role === ROLE_EVALUATOR) {
    const recommendation = provided ? value : previous;
    if (!RECOMMENDATIONS.has(recommendation)) {
      fail("invalid-argument", "Choose Recommend, Recommend with revisions, or Do not recommend.");
    }
    return recommendation;
  }
  if (provided) fail("invalid-argument", "Only assigned evaluators can submit a recommendation.");
  return null;
}

export function commentIsQualifying(data, role) {
  return !data.deletedAt
    && !BLOCKED.has(data.moderationStatus)
    && (data.parentId ?? null) == null
    && role === ROLE_EVALUATOR
    && data.badge === EVALUATOR_BADGE
    && RECOMMENDATIONS.has(data.recommendation);
}

const SUMMARY_CAP = 200;
const COUNT_KEYS = ["recommend", "recommend_with_revisions", "do_not_recommend", "qualifyingCount", "commentCount"];

function emptyCounts() {
  return Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));
}

function commentCounts(data) {
  const counts = emptyCounts();
  if (!data || data.deletedAt || BLOCKED.has(data.moderationStatus)) return counts;
  counts.commentCount = 1;
  if (data.qualifying === true && (data.parentId ?? null) == null && RECOMMENDATIONS.has(data.recommendation)) {
    counts.qualifyingCount = 1;
    counts[data.recommendation] = 1;
  }
  return counts;
}

function addCounts(target, extra) {
  for (const key of COUNT_KEYS) target[key] += extra[key] || 0;
  return target;
}

async function feedbackSummaryReads(tx, db, proposalId) {
  if (!proposalId) return [];
  const rows = await tx.get(db.collection("comments").where("proposalId", "==", proposalId).limit(SUMMARY_CAP));
  return rows.docs;
}

function applyFeedbackSummary(tx, db, docs, { commentId, next, proposalId, problemId, now }) {
  if (!proposalId) return;
  const counts = emptyCounts();
  for (const doc of docs) {
    if (doc.id === commentId) continue;
    addCounts(counts, commentCounts(doc.data()));
  }
  if (next) addCounts(counts, commentCounts(next));
  tx.set(db.collection("proposalFeedbackSummaries").doc(proposalId), {
    proposalId, problemId: problemId || "", ...counts, updatedAt: now,
  });
}

function view(id, data) {
  return {
    id,
    authorId: data.authorId,
    proposalId: data.proposalId,
    problemId: data.problemId,
    parentId: data.parentId ?? null,
    replyCount: data.replyCount ?? 0,
    body: data.body,
    authorRole: data.authorRole,
    badge: data.badge,
    recommendation: data.recommendation ?? null,
    qualifying: data.qualifying === true,
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
    editedAt: iso(data.editedAt),
    deletedAt: iso(data.deletedAt),
    deleted: Boolean(data.deletedAt),
  };
}

function revision(action, data, at) {
  return { action, body: data.body, recommendation: data.recommendation ?? null, at };
}

async function loadMember(tx, db, uid) {
  if (!uid) fail("unauthenticated", "Sign in to continue.");
  const profile = await tx.get(db.collection("users").doc(uid));
  if (!profile.exists || profile.data().suspended) fail("permission-denied", "An active member profile is required.");
  return profile.data();
}

async function loadReadableProposal(tx, db, uid, profile, proposalId) {
  const proposal = await tx.get(db.collection("proposals").doc(proposalId));
  if (!proposal.exists) fail("permission-denied", "This discussion is not available.");
  const data = proposal.data();
  if (data.status === "draft") fail("failed-precondition", "Comments are only allowed on submitted solutions.");
  if (!data.problemId) fail("failed-precondition", "This proposal is not linked to an opportunity.");
  if (!await canReadContent(tx, db, "proposal", data, uid, profile)) {
    fail("permission-denied", "This discussion is not available.");
  }
  return proposal;
}

function isMockEvaluation(matching = {}) {
  return matching.evaluationMockComplete === true || Boolean(matching.evaluationCompletedBy);
}

async function evaluationGateReads(tx, db, { proposalId, commentId, qualifying, holder }) {
  if (!proposalId) return { proposal: null, complete: qualifying, holder: holder ?? null };
  const proposalRef = db.collection("proposals").doc(proposalId);
  if (qualifying) return { proposal: await tx.get(proposalRef), complete: true, holder: holder ?? null };
  const [proposal, rows] = await Promise.all([
    tx.get(proposalRef),
    tx.get(db.collection("comments").where("proposalId", "==", proposalId).where("qualifying", "==", true).limit(5)),
  ]);
  // Whichever qualifying comment is left owns the recommendation now.
  const remaining = rows.docs.filter((doc) => doc.id !== commentId);
  const survivor = remaining[0];
  return { proposal: proposal.exists ? proposal : null,
    complete: remaining.length > 0,
    holder: survivor
      ? { by: survivor.data().authorId, commentId: survivor.id, recommendation: survivor.data().recommendation ?? null }
      : null };
}

function nextEvaluationComplete(proposal, complete) {
  if (!proposal?.exists) return null;
  const matching = proposal.data().matching || {};
  const evaluationComplete = complete || isMockEvaluation(matching);
  if (evaluationComplete === (matching.evaluationComplete === true)) return null;
  return evaluationComplete;
}

/** The recommendation a solution currently carries, or null. */
export function recommendationHolder(proposalData) {
  const matching = proposalData?.matching || {};
  return matching.recommendedBy
    ? { by: matching.recommendedBy, commentId: matching.recommendationCommentId ?? null,
      recommendation: matching.recommendation ?? null }
    : null;
}

// Writing the holder onto the solution is also what serialises two evaluators
// recommending at once: both transactions read this document, so the loser
// retries, sees the winner, and is refused instead of filing a second opinion.
function applyEvaluationComplete(tx, proposal, { complete, now, holder }) {
  if (!proposal?.exists) return;
  const current = proposal.data().matching || {};
  const evaluationComplete = complete || isMockEvaluation(current);
  const keep = holder === undefined;
  const nextBy = keep ? (current.recommendedBy ?? null) : (holder?.by ?? null);
  const nextCommentId = keep ? (current.recommendationCommentId ?? null) : (holder?.commentId ?? null);
  const nextValue = keep ? (current.recommendation ?? null) : (holder?.recommendation ?? null);
  if (evaluationComplete === (current.evaluationComplete === true)
    && nextBy === (current.recommendedBy ?? null)
    && nextCommentId === (current.recommendationCommentId ?? null)
    && nextValue === (current.recommendation ?? null)) return;
  const matching = { ...current, evaluationComplete, recommendedBy: nextBy,
    recommendationCommentId: nextCommentId, recommendation: nextValue,
    evaluationCompletedAt: evaluationComplete ? (current.evaluationCompletedAt || now) : null,
    updatedAt: now };
  tx.update(proposal.ref, { matching });
}

const RECOMMENDATION_LABEL = {
  recommend: "Recommend",
  recommend_with_revisions: "Recommend with revisions",
  do_not_recommend: "Do not recommend",
};

async function workflowNoticeRecipients(tx, db, proposal, { exclude } = {}) {
  if (!proposal?.exists) return [];
  const data = proposal.data();
  let ownerId = data.postingOwnerId || "";
  if (data.problemId) {
    const problem = await tx.get(db.collection("problems").doc(data.problemId));
    if (problem.exists) ownerId = problem.data().ownerId || ownerId;
  }
  const skip = exclude ? String(exclude).toLowerCase() : "";
  return [...new Set([ownerId, data.researcherId].filter(Boolean).map((id) => String(id).toLowerCase()).filter((id) => id !== skip))];
}

async function queueCommentNotices(tx, db, { id, recipients, record, proposal, now, kind, message }) {
  if (!recipients.length || !proposal?.exists) return [];
  const data = proposal.data();
  const existing = await Promise.all(recipients.map((uid) => tx.get(db.collection("moderationNotifications").doc(`${id}_${uid}`))));
  const title = String(data.title || "Proposal").slice(0, 160);
  return existing.map((snap, i) => ({
    snap,
    payload: memberNoticeFields({
      recipientId: recipients[i], now, createdAt: record?.createdAt || now, kind,
      contentType: "comment", contentId: record?.id || record?.commentId, proposalId: data.problemId ? proposal.id : record?.proposalId,
      problemId: record?.problemId || data.problemId, title, message: message(title),
    }),
  }));
}

async function queueQualifyingNotices(tx, db, { commentId, record, proposal, now }) {
  if (!record.qualifying) return [];
  const recipients = await workflowNoticeRecipients(tx, db, proposal, { exclude: record.authorId });
  const outcome = RECOMMENDATION_LABEL[record.recommendation] || "a recommendation";
  return queueCommentNotices(tx, db, {
    id: `qualifying_${commentId}`, recipients, record: { ...record, commentId }, proposal, now,
    kind: "qualifying_recommendation",
    message: (title) => `An evaluator submitted a qualifying recommendation on “${title}”: ${outcome}.`,
  });
}

async function queueQualifyingRemovedNotices(tx, db, { commentId, record, proposal, now }) {
  if (!record.qualifying) return [];
  const recipients = await workflowNoticeRecipients(tx, db, proposal, { exclude: record.authorId });
  return queueCommentNotices(tx, db, {
    id: `qualifying_removed_${commentId}`, recipients, record: { ...record, commentId }, proposal, now,
    kind: "qualifying_recommendation_removed",
    message: (title) => `An evaluator removed a qualifying recommendation from “${title}”.`,
  });
}

async function queueEvaluationGateNotices(tx, db, { proposal, complete, now }) {
  const evaluationComplete = nextEvaluationComplete(proposal, complete);
  if (evaluationComplete == null) return [];
  const recipients = await workflowNoticeRecipients(tx, db, proposal);
  const data = proposal.data();
  const state = evaluationComplete ? "closed" : "opened";
  const existing = await Promise.all(recipients.map((uid) =>
    tx.get(db.collection("moderationNotifications").doc(`gate_${proposal.id}_${state}_${now.toMillis()}_${uid}`))));
  const title = String(data.title || "Proposal").slice(0, 160);
  return existing.map((snap, i) => ({
    snap,
    payload: memberNoticeFields({
      recipientId: recipients[i], now, createdAt: now,
      kind: "evaluation_gate", contentType: "proposal", contentId: proposal.id,
      proposalId: proposal.id, problemId: data.problemId, title,
      message: evaluationComplete
        ? `The evaluator recommendation-comment gate closed on “${title}”.`
        : `The evaluator recommendation-comment gate opened on “${title}”.`,
    }),
  }));
}

function applyQueuedNotices(tx, queued) {
  for (const { snap, payload } of queued) {
    if (!snap.exists) tx.set(snap.ref, payload);
  }
}

function authoredComment(tx, db, uid, commentId) {
  validId(commentId, "comment");
  const ref = db.collection("comments").doc(commentId);
  return tx.get(ref).then((comment) => {
    if (!comment.exists) fail("not-found", "This comment is not available.");
    if (comment.data().authorId !== uid) fail("permission-denied", "You can only change your own comment.");
    return { ref, data: comment.data() };
  });
}

function replyParentId(value) {
  if (value == null || value === "") return null;
  validId(value, "parent comment");
  return value;
}

async function loadReplyParent(tx, db, proposalId, parentId) {
  if (!parentId) return null;
  const ref = db.collection("comments").doc(parentId);
  const parent = await tx.get(ref);
  if (!parent.exists) fail("not-found", "This comment is not available.");
  const data = parent.data();
  if (data.proposalId !== proposalId) fail("invalid-argument", "Reply to a comment on this solution.");
  if ((data.parentId ?? null) != null) fail("failed-precondition", "Replies can only be added to a top-level comment.");
  if (BLOCKED.has(data.moderationStatus)) fail("failed-precondition", "This comment is not available.");
  return parent;
}

async function assertReplyAllowance(tx, db, parent, uid) {
  if (!parent) return;
  if ((parent.data().replyCount || 0) >= REPLIES_PER_THREAD) {
    fail("resource-exhausted", "This thread has reached its reply limit.");
  }
  const mine = await tx.get(db.collection("comments").where("parentId", "==", parent.id)
    .where("authorId", "==", uid).limit(REPLIES_PER_MEMBER_PER_THREAD));
  if (mine.size >= REPLIES_PER_MEMBER_PER_THREAD) {
    fail("resource-exhausted", "You have reached your reply limit for this thread.");
  }
}

export async function createComment({ db, uid, proposalId, body, recommendation, parentId, now = Timestamp.now() }) {
  validId(proposalId, "proposal");
  const text = commentBody(body);
  const replyTo = replyParentId(parentId);
  const ref = db.collection("comments").doc(randomBytes(12).toString("hex"));
  return db.runTransaction(async (tx) => {
    const profile = await loadMember(tx, db, uid);
    const proposal = await loadReadableProposal(tx, db, uid, profile, proposalId);
    const parent = await loadReplyParent(tx, db, proposalId, replyTo);
    await assertReplyAllowance(tx, db, parent, uid);
    const role = accessLevel(profile);
    assertRecommendationAllowed({ proposal, uid, recommendation, isReply: Boolean(replyTo) });
    // An evaluator may still discuss their own solution - they just cannot judge it,
    // and a solution carries one recommendation, so a second evaluator is refused.
    const recommends = canRecommend({ proposal, uid, role, isReply: Boolean(replyTo) });
    const shown = presentation(role);
    const record = {
      authorId: uid,
      proposalId,
      problemId: proposal.data().problemId,
      parentId: replyTo,
      replyCount: 0,
      body: text,
      ...shown,
      recommendation: recommendationFor(recommends ? role : 0, recommendation, null, { reply: Boolean(replyTo) }),
      qualifying: false,
      ...GRADING,
      moderationStatus: "visible",
      revisions: [],
      createdAt: now,
      updatedAt: now,
    };
    record.qualifying = commentIsQualifying(record, role);
    const gate = await evaluationGateReads(tx, db, { proposalId, commentId: ref.id, qualifying: record.qualifying,
      holder: record.qualifying ? { by: uid, commentId: ref.id, recommendation: record.recommendation } : undefined });
    const notices = await queueQualifyingNotices(tx, db, { commentId: ref.id, record, proposal, now });
    const gateNotices = await queueEvaluationGateNotices(tx, db, { proposal: gate.proposal, complete: gate.complete, now });
    const summaryDocs = await feedbackSummaryReads(tx, db, proposalId);
    tx.set(ref, record);
    if (parent) tx.update(parent.ref, { replyCount: (parent.data().replyCount || 0) + 1 });
    applyEvaluationComplete(tx, gate.proposal, { complete: gate.complete, now, holder: gate.holder });
    applyQueuedNotices(tx, notices);
    applyQueuedNotices(tx, gateNotices);
    applyFeedbackSummary(tx, db, summaryDocs, {
      commentId: ref.id, next: record, proposalId, problemId: proposal.data().problemId, now,
    });
    return view(ref.id, record);
  });
}

export async function editComment({ db, uid, commentId, body, recommendation, now = Timestamp.now() }) {
  const text = commentBody(body);
  return db.runTransaction(async (tx) => {
    const profile = await loadMember(tx, db, uid);
    const { ref, data } = await authoredComment(tx, db, uid, commentId);
    if (data.deletedAt) fail("failed-precondition", "This comment was deleted.");
    if (now.toMillis() - millis(data.createdAt) > COMMENT_EDIT_WINDOW_MS) {
      fail("failed-precondition", "Comments can only be edited within 15 minutes of posting.");
    }
    const proposal = await loadReadableProposal(tx, db, uid, profile, data.proposalId);
    const role = accessLevel(profile);
    const isReply = (data.parentId ?? null) != null;
    assertRecommendationAllowed({ proposal, uid, recommendation, isReply, commentId: ref.id });
    const recommends = canRecommend({ proposal, uid, role, isReply, commentId: ref.id });
    const shown = presentation(role);
    const next = {
      ...data,
      body: text,
      ...shown,
      recommendation: recommendationFor(recommends ? role : 0, recommendation, data.recommendation),
      updatedAt: now,
      editedAt: now,
      qftGrade: data.qftGrade ?? null,
      qftGradedAt: data.qftGradedAt ?? null,
      qftGradedBy: data.qftGradedBy ?? null,
      revisions: [...(data.revisions || []), revision("edit", data, now)],
    };
    next.qualifying = commentIsQualifying(next, role);
    const gate = await evaluationGateReads(tx, db, { proposalId: data.proposalId, commentId: ref.id, qualifying: next.qualifying,
      holder: next.qualifying ? { by: uid, commentId: ref.id, recommendation: next.recommendation } : undefined });
    const notices = next.qualifying && !data.qualifying
      ? await queueQualifyingNotices(tx, db, { commentId: ref.id, record: next, proposal: gate.proposal, now })
      : [];
    const gateNotices = await queueEvaluationGateNotices(tx, db, { proposal: gate.proposal, complete: gate.complete, now });
    const summaryDocs = await feedbackSummaryReads(tx, db, data.proposalId);
    tx.set(ref, next);
    applyEvaluationComplete(tx, gate.proposal, { complete: gate.complete, now, holder: gate.holder });
    applyQueuedNotices(tx, notices);
    applyQueuedNotices(tx, gateNotices);
    applyFeedbackSummary(tx, db, summaryDocs, {
      commentId: ref.id, next, proposalId: data.proposalId, problemId: data.problemId, now,
    });
    return view(ref.id, next);
  });
}

export async function prepareCommentEvaluationGate({ tx, db, contentId, data, action, now }) {
  const moderationStatus = action === "restore" ? "visible"
    : action === "hide" ? "hidden"
    : action === "remove" ? "removed"
    : data.moderationStatus;
  const author = data.authorId ? await tx.get(db.collection("users").doc(data.authorId)) : null;
  const qualifying = commentIsQualifying({ ...data, moderationStatus }, accessLevel(author?.data()));
  const gate = await evaluationGateReads(tx, db, { proposalId: data.proposalId, commentId: contentId, qualifying,
    holder: qualifying
      ? { by: data.authorId, commentId: contentId, recommendation: data.recommendation ?? null }
      : undefined });
  const gateNotices = await queueEvaluationGateNotices(tx, db, { proposal: gate.proposal, complete: gate.complete, now });
  const summaryDocs = await feedbackSummaryReads(tx, db, data.proposalId);
  const next = { ...data, moderationStatus, qualifying };
  return {
    qualifying,
    apply() {
      applyEvaluationComplete(tx, gate.proposal, { complete: gate.complete, now, holder: gate.holder });
      applyQueuedNotices(tx, gateNotices);
      applyFeedbackSummary(tx, db, summaryDocs, {
        commentId: contentId, next, proposalId: data.proposalId, problemId: data.problemId, now,
      });
    },
  };
}

export async function deleteComment({ db, uid, commentId, now = Timestamp.now() }) {
  return db.runTransaction(async (tx) => {
    await loadMember(tx, db, uid);
    const { ref, data } = await authoredComment(tx, db, uid, commentId);
    if (data.deletedAt) return view(ref.id, data);
    const parent = data.parentId ? await tx.get(db.collection("comments").doc(data.parentId)) : null;
    const next = {
      ...data,
      qualifying: false,
      deletedAt: now,
      deletedBy: uid,
      updatedAt: now,
      revisions: [...(data.revisions || []), revision("delete", data, now)],
    };
    const gate = await evaluationGateReads(tx, db, { proposalId: data.proposalId, commentId: ref.id, qualifying: false });
    const removedNotices = await queueQualifyingRemovedNotices(tx, db, {
      commentId: ref.id, record: data, proposal: gate.proposal, now,
    });
    const gateNotices = await queueEvaluationGateNotices(tx, db, { proposal: gate.proposal, complete: gate.complete, now });
    const summaryDocs = await feedbackSummaryReads(tx, db, data.proposalId);
    tx.set(ref, next);
    if (parent?.exists) {
      tx.update(parent.ref, { replyCount: Math.max(0, (parent.data().replyCount || 0) - 1) });
    }
    applyEvaluationComplete(tx, gate.proposal, { complete: gate.complete, now, holder: gate.holder });
    applyQueuedNotices(tx, removedNotices);
    applyQueuedNotices(tx, gateNotices);
    applyFeedbackSummary(tx, db, summaryDocs, {
      commentId: ref.id, next, proposalId: data.proposalId, problemId: data.problemId, now,
    });
    return view(ref.id, next);
  });
}
