import { randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { canReadContent } from "./moderation.js";

export const ROLE_EVALUATOR = 2;
export const ROLE_ADMIN = 1;
export const COMMENT_EDIT_WINDOW_MS = 15 * 60 * 1000;
export const COMMENT_BODY_MAX = 5000;
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

function recommendationFor(role, value, previous = null) {
  const provided = value != null && value !== "";
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

function view(id, data) {
  return {
    id,
    authorId: data.authorId,
    proposalId: data.proposalId,
    problemId: data.problemId,
    parentId: data.parentId ?? null,
    body: data.body,
    authorRole: data.authorRole,
    badge: data.badge,
    recommendation: data.recommendation ?? null,
    qualifying: data.qualifying === true,
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
    editedAt: iso(data.editedAt),
    deletedAt: iso(data.deletedAt),
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
  return data;
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

export async function createComment({ db, uid, proposalId, body, recommendation, now = Timestamp.now() }) {
  validId(proposalId, "proposal");
  const text = commentBody(body);
  const ref = db.collection("comments").doc(randomBytes(12).toString("hex"));
  return db.runTransaction(async (tx) => {
    const profile = await loadMember(tx, db, uid);
    const proposal = await loadReadableProposal(tx, db, uid, profile, proposalId);
    const role = accessLevel(profile);
    const shown = presentation(role);
    const record = {
      authorId: uid,
      proposalId,
      problemId: proposal.problemId,
      parentId: null,
      body: text,
      ...shown,
      recommendation: recommendationFor(role, recommendation),
      qualifying: false,
      ...GRADING,
      moderationStatus: "visible",
      revisions: [],
      createdAt: now,
      updatedAt: now,
    };
    record.qualifying = commentIsQualifying(record, role);
    tx.set(ref, record);
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
    await loadReadableProposal(tx, db, uid, profile, data.proposalId);
    const role = accessLevel(profile);
    const shown = presentation(role);
    const next = {
      ...data,
      body: text,
      ...shown,
      recommendation: recommendationFor(role, recommendation, data.recommendation),
      updatedAt: now,
      editedAt: now,
      qftGrade: data.qftGrade ?? null,
      qftGradedAt: data.qftGradedAt ?? null,
      qftGradedBy: data.qftGradedBy ?? null,
      revisions: [...(data.revisions || []), revision("edit", data, now)],
    };
    next.qualifying = commentIsQualifying(next, role);
    tx.set(ref, next);
    return view(ref.id, next);
  });
}

export async function deleteComment({ db, uid, commentId, now = Timestamp.now() }) {
  return db.runTransaction(async (tx) => {
    await loadMember(tx, db, uid);
    const { ref, data } = await authoredComment(tx, db, uid, commentId);
    if (data.deletedAt) return view(ref.id, data);
    const next = {
      ...data,
      qualifying: false,
      deletedAt: now,
      deletedBy: uid,
      updatedAt: now,
      revisions: [...(data.revisions || []), revision("delete", data, now)],
    };
    tx.set(ref, next);
    return view(ref.id, next);
  });
}
