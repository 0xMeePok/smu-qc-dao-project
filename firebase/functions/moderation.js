import { createHash } from "node:crypto";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { WORKFLOW_STATUS } from "./workflowStatus.js";
import { isIndependentProposal } from "./independentProposal.js";

export const REPORT_REASONS = ["off_topic", "abusive", "misleading", "duplicate", "other"];
const REMOVE_REASONS = ["off_topic", "abusive", "misleading", "duplicate", "spam", "policy_violation", "other"];
const RESTORE_REASONS = ["no_violation", "appeal_accepted"];
export const MODERATION_REASONS = [...REMOVE_REASONS, ...RESTORE_REASONS];
const ACTION_REASONS = { remove: REMOVE_REASONS, restore: RESTORE_REASONS };
const TYPES = { problem: "problems", proposal: "proposals", comment: "comments" };
const DECISIONS = { remove: "removed", restore: "restored" };
const BLOCKED = new Set(["hidden", "removed"]);
const PAGE_SIZE = 50;
const MEMBER_VISIBLE_PROPOSAL = ["submitted", "under_review", "accepted", "rejected", "withdrawn"];
const POSTED_PROPOSAL_CAP = 200;
const VISIBILITY_SYNC_PAGE = 300;
// A discussion response is bounded: a page of parents, a preview of replies under
// each, and a capped set of author-name lookups. Whole threads page separately.
const COMMENT_PAGE = 100;
const PROPOSAL_COMMENT_PAGE = 25;
const REPLY_PREVIEW = 3;
const THREAD_REPLY_PAGE = 20;
const AUTHOR_LOOKUP_CAP = 120;
const VISIBILITY_SYNC_BUDGET_MS = 45_000;
const BROWSABLE_PROBLEM_STATUS = new Set(["submitted", "open", "cancelled", "expired"]);
const fail = (code, message) => { throw new HttpsError(code, message); };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const owner = (type, data) => type === "problem" ? data.ownerId : type === "proposal" ? data.researcherId : data.authorId || data.userId || data.ownerId;
const excerpt = (data) => String(data.summary || data.body || data.text || data.content || data.fundingThesis || "").slice(0, 500);
const isPublished = (type, data) => data.status !== "draft" && (type === "comment" || Boolean(data.status));
const serialise = (value) => {
  if (value?.toDate) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialise);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialise(item)]));
  return value;
};
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RECORD_TARGET = /^(posting|proposal)\/[A-Za-z0-9_-]{1,128}$/;
export function notificationNavigationTarget(data = {}) {
  if (RECORD_TARGET.test(data.navigationTarget || "")) return data.navigationTarget;
  const proposalId = data.proposalId || (data.contentType === "proposal" ? data.contentId : "");
  const problemId = data.problemId || (data.contentType === "problem" ? data.contentId : "");
  if ((data.contentType === "proposal" || data.contentType === "comment") && RECORD_ID.test(proposalId)) return `proposal/${proposalId}`;
  if (RECORD_ID.test(problemId)) return `posting/${problemId}`;
  return null;
}
export function memberNoticeFields({ recipientId, now, createdAt, ...fields }) {
  const navigationTarget = notificationNavigationTarget(fields);
  return {
    recipientId: String(recipientId).toLowerCase(), kind: fields.kind || null, contentType: fields.contentType || null, contentId: fields.contentId || null,
    title: String(fields.title || "").slice(0, 160), message: fields.message, workflowStatus: fields.workflowStatus || null,
    problemId: fields.problemId || null, proposalId: fields.proposalId || null,
    navigationTarget, link: navigationTarget ? `#/${navigationTarget}` : null,
    createdAt: createdAt || now, deliveredAt: now, readAt: null,
  };
}
export async function writeMemberNotice({ db, id, recipientId, now = Timestamp.now(), createdAt, ...fields }) {
  if (!recipientId || typeof id !== "string") return { written: false };
  const ref = db.collection("moderationNotifications").doc(id);
  return db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return { written: false };
    tx.set(ref, memberNoticeFields({ recipientId, now, createdAt, ...fields }));
    return { written: true };
  });
}
export async function notifyProposalReceived({ db, proposalId, before, after, now = Timestamp.now() }) {
  if (!after || after.status !== "submitted") return { written: false };
  if (before?.status && before.status !== "draft") return { written: false };
  const recipientId = after.postingOwnerId;
  if (!recipientId) return { written: false };
  const title = String(after.title || "Proposal").slice(0, 160);
  return writeMemberNotice({
    db, now, createdAt: after.createdAt || now, id: `received_${proposalId}`, recipientId,
    kind: "proposal_received", workflowStatus: WORKFLOW_STATUS.SUBMITTED, contentType: "proposal", contentId: proposalId, proposalId,
    problemId: after.problemId || null, title,
    message: `A new proposal “${title}” was submitted on your posting.`,
  });
}
function validateContent(contentType, contentId) {
  if (!Object.hasOwn(TYPES, contentType) || typeof contentId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(contentId)) fail("invalid-argument", "Choose a valid content item.");
  return `${contentType}_${contentId}`;
}
function parseQueueId(queueId) {
  if (typeof queueId !== "string") fail("invalid-argument", "Choose a moderation item.");
  const index = queueId.indexOf("_");
  const contentType = queueId.slice(0, index), contentId = queueId.slice(index + 1);
  validateContent(contentType, contentId);
  return { contentType, contentId };
}
function validDetails(details) {
  if (details == null) return "";
  if (typeof details !== "string" || details.trim().length > 2000) fail("invalid-argument", "Use at most 2,000 characters for supporting details.");
  return details.trim();
}
function cursorTimestamp(cursor) {
  if (cursor.seconds !== undefined || cursor.nanoseconds !== undefined) {
    if (!Number.isSafeInteger(cursor.seconds) || cursor.seconds < -62135596800 || cursor.seconds > 253402300799
      || !Number.isInteger(cursor.nanoseconds) || cursor.nanoseconds < 0 || cursor.nanoseconds > 999999999) {
      fail("invalid-argument", "Invalid timestamp cursor.");
    }
    return new Timestamp(cursor.seconds, cursor.nanoseconds);
  }
  if (typeof cursor.value !== "string" || !Number.isFinite(new Date(cursor.value).getTime())) fail("invalid-argument", "Invalid timestamp cursor.");
  try { return Timestamp.fromDate(new Date(cursor.value)); }
  catch { fail("invalid-argument", "Invalid timestamp cursor."); }
}
function timestampCursor(id, timestamp) {
  return { id, value: serialise(timestamp), seconds: timestamp.seconds, nanoseconds: timestamp.nanoseconds };
}
async function activeProfile(tx, db, uid, admin = false) {
  if (!uid) fail("unauthenticated", "Sign in to continue.");
  const profile = await tx.get(db.collection("users").doc(uid));
  if (!profile.exists || profile.data().suspended || (admin && profile.data().role !== 1)) {
    fail("permission-denied", admin ? "An active administrator account is required." : "An active member profile is required.");
  }
  return profile.data();
}

export function problemIsMemberBrowsable(data) {
  return Boolean(data && BROWSABLE_PROBLEM_STATUS.has(data.status) && !BLOCKED.has(data.moderationStatus));
}

function stampProposalBrowsable(tx, doc, problemBrowsable, now) {
  const data = doc.data();
  if (!data || data.status === "draft" || data.problemBrowsable === problemBrowsable) return;
  tx.update(doc.ref, { problemBrowsable, updatedAt: now });
}

export async function syncProposalParentVisibility({ db, proposalId, now = Timestamp.now() }) {
  return db.runTransaction(async (tx) => {
    const proposal = await tx.get(db.collection("proposals").doc(proposalId));
    if (!proposal.exists || proposal.data().status === "draft") return { ok: true };
    const problemId = proposal.data().problemId;
    const parent = problemId ? await tx.get(db.collection("problems").doc(problemId)) : null;
    stampProposalBrowsable(tx, proposal, problemIsMemberBrowsable(parent?.exists ? parent.data() : null), now);
    return { ok: true };
  });
}

export async function syncProblemProposalsBrowsable({
  db, problemId, now = Timestamp.now(), pageSize = VISIBILITY_SYNC_PAGE,
  budgetMs = VISIBILITY_SYNC_BUDGET_MS, clock = Date.now,
} = {}) {
  const startedAt = clock();
  const parent = await db.collection("problems").doc(problemId).get();
  if (!parent.exists) return { ok: true, synced: 0, complete: true };
  const problemBrowsable = problemIsMemberBrowsable(parent.data());
  // Storage authorises proposal PDFs from each child's own problemBrowsable flag,
  // so EVERY child has to be stamped - not the first page. A hidden posting with
  // more children than one page would otherwise keep serving their PDFs.
  const checkpointRef = db.collection("jobState").doc(`proposalVisibility_${problemId}`);
  const checkpoint = (await checkpointRef.get()).data() ?? {};
  let cursor = checkpoint.problemBrowsable === problemBrowsable ? checkpoint.cursorId ?? null : null;
  let synced = 0;
  let complete = false;
  while (clock() - startedAt < budgetMs) {
    let query = db.collection("proposals").where("problemId", "==", problemId)
      .where("status", "in", MEMBER_VISIBLE_PROPOSAL)
      .orderBy(FieldPath.documentId(), "asc").limit(pageSize);
    if (cursor) query = query.startAfter(cursor);
    const rows = await query.get();
    if (rows.empty) { complete = true; break; }
    const stale = rows.docs.filter((doc) => doc.data()
      && doc.data().status !== "draft" && doc.data().problemBrowsable !== problemBrowsable);
    const writes = stale.length;
    // One transaction per page: the page is bounded well under the 500-write cap.
    if (writes) {
      await db.runTransaction(async (tx) => {
        for (const doc of stale) tx.update(doc.ref, { problemBrowsable, updatedAt: now });
      });
    }
    synced += writes;
    cursor = rows.docs.at(-1).id;
    if (rows.size < pageSize) { complete = true; break; }
  }
  if (complete) {
    if (checkpoint.cursorId) await checkpointRef.delete();
    return { ok: true, synced, complete: true };
  }
  // Resumable: the next pass continues from here rather than starting over.
  await checkpointRef.set({ problemId, problemBrowsable, cursorId: cursor, updatedAt: now });
  return { ok: true, synced, complete: false, cursorId: cursor };
}

export async function canReadContent(tx, db, type, data, uid, profile) {
  if (profile.role === 1 || owner(type, data) === uid) return true;
  if (BLOCKED.has(data.moderationStatus) || !isPublished(type, data)) return false;
  if (type === "problem") return ["submitted", "open", "cancelled", "expired"].includes(data.status);
  if (type === "proposal") {
    if (data.postingOwnerId === uid) return true;
    if (isIndependentProposal(data)) return MEMBER_VISIBLE_PROPOSAL.includes(data.status);
    if (!data.problemId) return false;
    const parent = await tx.get(db.collection("problems").doc(data.problemId));
    return parent.exists && canReadContent(tx, db, "problem", parent.data(), uid, profile);
  }
  const parentType = data.proposalId ? "proposal" : "problem";
  const parentId = data.proposalId || data.problemId;
  if (!parentId) return false;
  const parent = await tx.get(db.collection(TYPES[parentType]).doc(parentId));
  return parent.exists && canReadContent(tx, db, parentType, parent.data(), uid, profile);
}
function queueRecord(type, id, data, authorProfile, previous = {}) {
  return {
    reportCount: 0, reportReasons: {}, sortReports: 0, ruleFlags: [], status: "pending", ...previous,
    contentType: type, contentId: id, title: String(data.title || (type === "comment" ? "Comment" : "Untitled item")).slice(0, 160),
    excerpt: excerpt(data),     authorId: owner(type, data) || "", authorName: authorProfile?.fullName || "",
    organisation: data.organisation || authorProfile?.organisation || "", proposalKind: data.proposalKind || null,
    contentCreatedAt: data.createdAt || null,
    parentId: data.problemId || data.proposalId || null,
  };
}
function pendingDelta(previous, nextStatus) {
  return Number(nextStatus === "pending") - Number(previous?.status === "pending");
}
function writeStats(tx, ref, stats, delta, now) {
  if (delta) tx.set(ref, { pendingCount: Math.max(0, (stats.data()?.pendingCount || 0) + delta), updatedAt: now });
}

/** Deterministic triage flags enqueue review; they never hide content themselves. */
export function moderationFlags(data) {
  const text = [data.title, data.summary, data.body, data.text, data.content, data.fundingThesis].filter((value) => typeof value === "string").join("\n");
  const flags = [];
  if ((text.match(/https?:\/\//gi) || []).length >= 5) flags.push("many_external_links");
  if (/(\b\w{3,}\b)(?:\s+\1){9,}/i.test(text)) flags.push("repeated_text");
  if (/\b(kill yourself|go kill yourself)\b/i.test(text)) flags.push("abusive_language");
  return flags;
}

/** Publishing content does not enter the moderation queue. Review starts from a member report. */
export async function flagSubmittedContent() {
  return { flagged: false };
}

export async function submitContentReport({ db, uid, contentType, contentId, reason, details, now = Timestamp.now() }) {
  const queueId = validateContent(contentType, contentId);
  if (!REPORT_REASONS.includes(reason)) fail("invalid-argument", "Choose a report reason.");
  const note = validDetails(details);
  return db.runTransaction(async (tx) => {
    const profile = await activeProfile(tx, db, uid);
    const contentRef = db.collection(TYPES[contentType]).doc(contentId);
    const reportRef = db.collection("contentReports").doc(hash(`${uid}:${queueId}`));
    const queueRef = db.collection("moderationQueue").doc(queueId);
    const statsRef = db.collection("moderationStats").doc("global");
    const limitRef = db.collection("moderationReportLimits").doc(uid);
    const [content, report, queue, stats, limit] = await Promise.all([tx.get(contentRef), tx.get(reportRef), tx.get(queueRef), tx.get(statsRef), tx.get(limitRef)]);
    if (!content.exists || !isPublished(contentType, content.data()) || !await canReadContent(tx, db, contentType, content.data(), uid, profile)) {
      fail("permission-denied", "This content is not available to report.");
    }
    if (report.exists) return { ok: true, alreadyReported: true };
    const day = now.toDate().toISOString().slice(0, 10);
    const count = limit.data()?.day === day ? limit.data().count : 0;
    if (count >= 20) fail("resource-exhausted", "You have reached today's report limit. Please try again tomorrow.");
    const data = content.data(), previous = queue.data();
    const authorId = owner(contentType, data);
    const author = authorId ? await tx.get(db.collection("users").doc(authorId)) : null;
    const status = BLOCKED.has(data.moderationStatus) ? data.moderationStatus : "pending";
    const reportCount = (previous?.reportCount || 0) + 1;
    const reportSummaries = [...(previous?.reportSummaries || [])];
    if (reportSummaries.length < 5) reportSummaries.push({ reason, details: note });
    tx.set(reportRef, { queueId, contentType, contentId, reporterId: uid, reason, details: note, createdAt: now });
    tx.set(queueRef, { ...queueRecord(contentType, contentId, data, author?.data(), previous), status,
      reportCount, sortReports: -reportCount, reportReasons: { ...previous?.reportReasons, [reason]: (previous?.reportReasons?.[reason] || 0) + 1 },
      reportSummaries, createdAt: previous?.createdAt || now, updatedAt: now });
    tx.set(limitRef, { day, count: count + 1, updatedAt: now });
    writeStats(tx, statsRef, stats, pendingDelta(previous, status), now);
    return { ok: true, alreadyReported: false };
  });
}

export async function listModerationQueue({ db, uid, contentType, status = "pending", sort = "oldest", cursor }) {
  if (contentType && !Object.hasOwn(TYPES, contentType)) fail("invalid-argument", "Choose a valid content type.");
  if (!["pending", "hidden", "removed", "restored", "all"].includes(status) || !["oldest", "most_reported"].includes(sort)) fail("invalid-argument", "Choose valid queue filters.");
  return db.runTransaction(async (tx) => {
    await activeProfile(tx, db, uid, true);
    let query = db.collection("moderationQueue");
    if (contentType) query = query.where("contentType", "==", contentType);
    if (status !== "all") query = query.where("status", "==", status);
    const sortField = sort === "most_reported" ? "sortReports" : "createdAt";
    query = query.orderBy(sortField).orderBy("__name__");
    if (cursor) {
      parseQueueId(cursor.id);
      const value = sort === "most_reported" ? cursor.value : cursorTimestamp(cursor);
      if (sort === "most_reported" && !Number.isSafeInteger(value)) fail("invalid-argument", "Invalid queue cursor.");
      query = query.startAfter(value, cursor.id);
    }
    const [rows, stats] = await Promise.all([tx.get(query.limit(PAGE_SIZE + 1)), tx.get(db.collection("moderationStats").doc("global"))]);
    const page = rows.docs.slice(0, PAGE_SIZE);
    const items = await Promise.all(page.map(async (doc) => {
      const data = doc.data();
      const stored = Array.isArray(data.reportSummaries) ? data.reportSummaries : [];
      const reportSummaries = stored.length ? stored : (await tx.get(db.collection("contentReports").where("queueId", "==", doc.id).orderBy("createdAt").limit(5))).docs
        .map((report) => ({ reason: report.data().reason || "", details: report.data().details || "" }));
      return { id: doc.id, ...serialise({ ...data, reportSummaries }), reasons: Object.keys(data.reportReasons || {}) };
    }));
    const last = items.at(-1);
    return { items, pendingCount: stats.data()?.pendingCount || 0,
      nextCursor: rows.size > PAGE_SIZE ? (sort === "oldest"
        ? timestampCursor(last.id, rows.docs[PAGE_SIZE - 1].data().createdAt)
        : { id: last.id, value: last[sortField] }) : null };
  });
}

export async function getModerationContext({ db, uid, queueId }) {
  const { contentType, contentId } = parseQueueId(queueId);
  return db.runTransaction(async (tx) => {
    await activeProfile(tx, db, uid, true);
    const [queue, content, reports, events] = await Promise.all([
      tx.get(db.collection("moderationQueue").doc(queueId)), tx.get(db.collection(TYPES[contentType]).doc(contentId)),
      tx.get(db.collection("contentReports").where("queueId", "==", queueId).orderBy("createdAt").limit(100)),
      tx.get(db.collection("moderationEvents").where("queueId", "==", queueId).orderBy("createdAt").limit(100)),
    ]);
    if (!queue.exists || !content.exists) fail("not-found", "Moderation content not found.");
    const data = content.data();
    let parent = null;
    if (data.proposalId || data.problemId) {
      const scope = data.proposalId ? "proposals" : "problems", id = data.proposalId || data.problemId;
      const snapshot = await tx.get(db.collection(scope).doc(id));
      if (snapshot.exists) parent = { id, contentType: data.proposalId ? "proposal" : "problem", ...serialise(snapshot.data()) };
    }
    return { item: { id: queue.id, ...serialise(queue.data()) }, content: { id: content.id, ...serialise(data) }, parent,
      reports: reports.docs.map((doc) => ({ id: doc.id, ...serialise(doc.data()) })),
      history: events.docs.map((doc) => ({ id: doc.id, ...serialise(doc.data()) })),
      reportsTruncated: reports.size === 100, historyTruncated: events.size === 100 };
  });
}

export async function moderateContent({ db, uid, queueId, action, reason, details, prepareMatching, prepareCommentGate, now = Timestamp.now() }) {
  const { contentType, contentId } = parseQueueId(queueId);
  if (action === "hide") fail("invalid-argument", "Hide is no longer available. Choose remove or restore.");
  if (!Object.hasOwn(DECISIONS, action) || !ACTION_REASONS[action].includes(reason)) fail("invalid-argument", "Choose a reason that matches this action.");
  const note = validDetails(details);
  return db.runTransaction(async (tx) => {
    await activeProfile(tx, db, uid, true);
    const ref = db.collection(TYPES[contentType]).doc(contentId);
    const queueRef = db.collection("moderationQueue").doc(queueId);
    const statsRef = db.collection("moderationStats").doc("global");
    const [content, queue, stats] = await Promise.all([tx.get(ref), tx.get(queueRef), tx.get(statsRef)]);
    if (!content.exists || !queue.exists || !isPublished(contentType, content.data())) fail("not-found", "Published moderation content not found.");
    const data = content.data(), previous = queue.data();
    if (previous.status === DECISIONS[action] && data.moderation?.lastAction === action && data.moderation.reason === reason && data.moderation.details === note) return { ok: true, unchanged: true };
    const authorId = owner(contentType, data);
    const sequence = (data.moderation?.sequence || 0) + 1;
    const eventId = `${queueId}_${sequence}`;
    // The matching helper performs every dependent read before returning its
    // write closure, so settlement and visibility commit in one transaction.
    const settlement = prepareMatching && contentType !== "comment"
      ? await prepareMatching({ db, tx, contentType, contentId, action, actorId: uid, now }) : null;
    const commentGate = prepareCommentGate && contentType === "comment"
      ? await prepareCommentGate({ db, tx, contentId, data, action, now }) : null;
    const hidden = BLOCKED.has(data.moderationStatus);
    const previousStatus = hidden ? data.moderation.previousStatus : data.status || "submitted";
    const originalPostingOwnerId = hidden ? data.moderation?.originalPostingOwnerId : data.postingOwnerId;
    const moderation = { ...data.moderation, previousStatus, lastAction: action, reason, details: note, moderatorId: uid, moderatedAt: now, sequence };
    if (contentType === "proposal") moderation.originalPostingOwnerId = originalPostingOwnerId || "";
    settlement?.apply?.();
    commentGate?.apply?.();
    tx.update(ref, { status: action === "restore" ? previousStatus : `moderated_${DECISIONS[action]}`,
      moderationStatus: action === "restore" ? "visible" : DECISIONS[action], moderation,
      ...(contentType === "proposal" ? { postingOwnerId: action === "restore" ? originalPostingOwnerId || "" : "" } : {}),
      ...(commentGate ? { qualifying: commentGate.qualifying } : {}), updatedAt: now });
    tx.update(queueRef, { status: DECISIONS[action], lastAction: action, lastReason: reason, updatedAt: now });
    writeStats(tx, statsRef, stats, pendingDelta(previous, DECISIONS[action]), now);
    const opensEscrowRefund = action === "remove" && contentType !== "comment" && !isIndependentProposal(data);
    tx.set(db.collection("moderationEvents").doc(eventId), {
      queueId, contentType, contentId, action, reason, details: note, actorId: uid, authorId: authorId || "",
      previousVisibility: data.moderationStatus || "visible", visibility: action === "restore" ? "visible" : DECISIONS[action],
      createdAt: now, sequence, chainStatus: "pending", eventVersion: 1, settlement: settlement?.summary || null,
      evaluationReadiness: commentGate?.readiness || null,
      escrowVoid: opensEscrowRefund ? { status: "queued" } : null,
    });
    if (authorId) {
      const proposalId = contentType === "proposal" ? contentId : data.proposalId || null;
      const problemId = contentType === "problem" ? contentId : data.problemId || null;
      const navigationTarget = notificationNavigationTarget({ contentType, contentId, proposalId, problemId });
      const noticeTitle = String(data.title || "Your comment").slice(0, 160);
      tx.set(db.collection("moderationNotifications").doc(`${eventId}_${authorId}`), {
        recipientId: authorId, queueId, contentType, contentId, title: noticeTitle,
        action, reason, details: note, createdAt: now, readAt: null,
        ...(opensEscrowRefund ? { message: `Your ${contentType} “${noticeTitle}” was removed. Mock pledges on this item are refunded. Linked on-chain escrows open a claim for the unpaid balance. Paid tranches stay paid.` } : {}),
        ...(problemId ? { problemId } : {}), ...(proposalId ? { proposalId } : {}),
        ...(navigationTarget ? { navigationTarget, link: `#/${navigationTarget}` } : {}),
      });
    }
    return { ok: true, eventId, status: DECISIONS[action] };
  });
}

export async function listModerationNotifications({ db, uid }) {
  return db.runTransaction(async (tx) => {
    await activeProfile(tx, db, uid);
    const rows = await tx.get(db.collection("moderationNotifications").where("recipientId", "==", uid).orderBy("createdAt", "desc").limit(50));
    return { items: rows.docs.map((doc) => {
      const data = doc.data();
      return { id: doc.id, ...serialise(data), read: Boolean(data.readAt),
        navigationTarget: notificationNavigationTarget(data),
        message: data.message || `Your ${data.contentType} “${data.title}” was ${data.action === "hide" ? "hidden" : data.action === "remove" ? "removed" : "restored"} by a moderator.` };
    }), truncated: rows.size === 50 };
  });
}
export async function markModerationNotificationRead({ db, uid, notificationId, now = Timestamp.now() }) {
  if (typeof notificationId !== "string" || !/^[A-Za-z0-9_-]{1,220}$/.test(notificationId)) fail("invalid-argument", "Choose a valid notification.");
  return db.runTransaction(async (tx) => {
    await activeProfile(tx, db, uid);
    const ref = db.collection("moderationNotifications").doc(notificationId), notification = await tx.get(ref);
    if (!notification.exists || notification.data().recipientId !== uid) fail("permission-denied", "This notification belongs to another member.");
    if (!notification.data().readAt) tx.update(ref, { readAt: now });
    return { ok: true };
  });
}
export async function markAllModerationNotificationsRead({ db, uid, now = Timestamp.now() }) {
  return db.runTransaction(async (tx) => {
    await activeProfile(tx, db, uid);
    const rows = await tx.get(db.collection("moderationNotifications").where("recipientId", "==", uid).orderBy("createdAt", "desc").limit(PAGE_SIZE));
    let updated = 0;
    for (const doc of rows.docs) {
      if (doc.data().readAt) continue;
      tx.update(doc.ref, { readAt: now });
      updated += 1;
    }
    return { ok: true, updated };
  });
}

function commentVisible(data, { uid, profile, proposalScoped }) {
  if (!(proposalScoped || !data.proposalId) || !isPublished("comment", data)) return false;
  if (BLOCKED.has(data.moderationStatus) && owner("comment", data) !== uid && profile.role !== 1) return false;
  if (!data.deletedAt) return true;
  return proposalScoped && (data.parentId ?? null) == null && (data.replyCount || 0) > 0;
}

function commentListItem(doc, names) {
  const data = doc.data();
  const removed = Boolean(data.deletedAt);
  const authorId = owner("comment", data) || "";
  return { id: doc.id, authorId: removed ? "" : authorId, authorName: removed ? "" : names.get(authorId) || "",
    authorRole: removed ? null : data.authorRole || null, badge: removed ? null : data.badge || null,
    recommendation: removed ? null : data.recommendation || null, qualifying: !removed && data.qualifying === true,
    problemId: data.problemId || null, proposalId: data.proposalId || null,
    parentId: data.parentId ?? null, replyCount: data.replyCount ?? 0, deleted: removed,
    body: removed ? "" : String(data.body || data.text || data.content || ""),
    createdAt: serialise(data.createdAt || null), editedAt: removed ? null : serialise(data.editedAt || null),
    moderationStatus: data.moderationStatus || "visible", moderation: serialise(data.moderation || null) };
}

async function loadCommentReplies(tx, db, parentIds, perParent = REPLY_PREVIEW) {
  if (!parentIds.length) return new Map();
  const pages = await Promise.all(parentIds.map((id) => tx.get(repliesQuery(db, id).limit(perParent + 1))));
  return new Map(parentIds.map((id, index) => {
    const docs = pages[index].docs;
    return [id, { docs: docs.slice(0, perParent), hasMore: docs.length > perParent }];
  }));
}

function repliesQuery(db, parentId) {
  return db.collection("comments").where("parentId", "==", parentId)
    .orderBy("createdAt", "asc").orderBy("__name__", "asc");
}

async function authorNames(tx, db, docs) {
  const ids = [...new Set(docs.map((doc) => owner("comment", doc.data()) || "").filter(Boolean))]
    .slice(0, AUTHOR_LOOKUP_CAP);
  const names = new Map();
  await Promise.all(ids.map(async (id) => {
    const publicProfile = await tx.get(db.collection("publicProfiles").doc(id));
    names.set(id, publicProfile.data()?.fullName || "");
  }));
  return names;
}

export async function listReportableComments({ db, uid, problemId, proposalId, cursor, sort, threadId }) {
  const parentType = proposalId ? "proposal" : "problem", parentId = proposalId || problemId;
  validateContent(parentType, parentId);
  if (sort != null && sort !== "" && sort !== "oldest" && sort !== "newest") fail("invalid-argument", "Choose oldest or newest first.");
  const newest = sort === "newest";
  if (cursor) {
    validateContent("comment", cursor.id);
    cursorTimestamp(cursor);
  }
  return db.runTransaction(async (tx) => {
    const profile = await activeProfile(tx, db, uid);
    const parent = await tx.get(db.collection(TYPES[parentType]).doc(parentId));
    if (!parent.exists || !await canReadContent(tx, db, parentType, parent.data(), uid, profile)) fail("permission-denied", "This discussion is not available.");
    if (proposalId && problemId && parent.data().problemId !== problemId) fail("permission-denied", "This proposal does not belong to that problem.");
    // One thread's replies, paginated. Parent access was proved above.
    if (threadId) {
      validateContent("comment", threadId);
      const thread = await tx.get(db.collection("comments").doc(threadId));
      if (!thread.exists || thread.data().proposalId !== parentId || (thread.data().parentId ?? null) != null) {
        fail("not-found", "This comment is not available.");
      }
      let threadQuery = repliesQuery(db, threadId);
      if (cursor) threadQuery = threadQuery.startAfter(cursorTimestamp(cursor), cursor.id);
      const replyRows = await tx.get(threadQuery.limit(THREAD_REPLY_PAGE + 1));
      const replyPage = replyRows.docs.slice(0, THREAD_REPLY_PAGE);
      const shown = replyPage.filter((doc) => commentVisible(doc.data(), { uid, profile, proposalScoped: true }));
      const replyNames = await authorNames(tx, db, shown);
      const lastReply = replyPage.at(-1);
      return {
        threadId,
        items: shown.map((doc) => commentListItem(doc, replyNames)),
        truncated: replyRows.size > THREAD_REPLY_PAGE,
        nextCursor: replyRows.size > THREAD_REPLY_PAGE
          ? timestampCursor(lastReply.id, lastReply.data().createdAt) : null,
      };
    }
    const pageSize = proposalId ? PROPOSAL_COMMENT_PAGE : COMMENT_PAGE;
    const direction = newest ? "desc" : "asc";
    let query = db.collection("comments").where(proposalId ? "proposalId" : "problemId", "==", parentId);
    if (proposalId) query = query.where("parentId", "==", null);
    query = query.orderBy("createdAt", direction).orderBy("__name__", direction);
    if (cursor) query = query.startAfter(cursorTimestamp(cursor), cursor.id);
    const rows = await tx.get(query.limit(pageSize + 1));
    const page = rows.docs.slice(0, pageSize);
    const visible = page.filter((doc) => commentVisible(doc.data(), { uid, profile, proposalScoped: Boolean(proposalId) }));
    const replies = proposalId ? await loadCommentReplies(tx, db, visible.map((doc) => doc.id)) : new Map();
    const visibleReplies = [...replies.values()].flatMap((entry) => entry.docs)
      .filter((doc) => commentVisible(doc.data(), { uid, profile, proposalScoped: true }));
    const names = await authorNames(tx, db, [...visible, ...visibleReplies]);
    const items = visible.map((doc) => {
      const item = commentListItem(doc, names);
      if (!proposalId) return item;
      const entry = replies.get(doc.id) ?? { docs: [], hasMore: false };
      const shown = entry.docs.filter((reply) => commentVisible(reply.data(), { uid, profile, proposalScoped: true }));
      const lastPreview = entry.docs.at(-1);
      return { ...item, replies: shown.map((reply) => commentListItem(reply, names)), hasMoreReplies: entry.hasMore,
        nextReplyCursor: entry.hasMore ? timestampCursor(lastPreview.id, lastPreview.data().createdAt) : null };
    });
    const last = page.at(-1);
    if (parentType === "proposal") {
      const problem = parent.data().problemId
        ? await tx.get(db.collection("problems").doc(parent.data().problemId)) : null;
      stampProposalBrowsable(tx, parent, problemIsMemberBrowsable(problem?.exists ? problem.data() : null), Timestamp.now());
    }
    return { items, truncated: rows.size > pageSize,
      nextCursor: rows.size > pageSize ? timestampCursor(last.id, last.data().createdAt) : null };
  });
}

function redactedProblem(doc) {
  const data = doc.data();
  return {
    id: doc.id, removed: true, moderationStatus: "removed",
    title: String(data.title || "Untitled opportunity").slice(0, 160),
    reason: data.moderation?.reason || "", details: data.moderation?.details || "",
    opportunityType: data.opportunityType === "open-funding" ? "open-funding" : "business-problem",
    createdAt: serialise(data.createdAt || null),
  };
}

function redactedProposal(doc, fallback = { reason: "", details: "" }) {
  const data = doc.data();
  const own = data.moderationStatus === "removed" || data.status === "moderated_removed";
  return {
    id: doc.id, removed: true, moderationStatus: "removed",
    title: String(data.title || "Untitled proposal").slice(0, 160),
    reason: own ? (data.moderation?.reason || fallback.reason || "") : (fallback.reason || ""),
    details: own ? (data.moderation?.details || "") : (fallback.details || ""),
    claimFunds: Boolean(data.fundingTerms) && !isIndependentProposal(data),
    createdAt: serialise(data.createdAt || null),
  };
}

function parentRemovalClaim(doc) {
  const data = doc.data();
  if (!data || data.status === "draft") return false;
  return Boolean(data.fundingTerms) || data.moderationStatus === "removed" || data.status === "moderated_removed";
}

/** Removed problems stay listed as a title and reason. The brief itself is not returned. */
export async function listRemovedProblems({ db, uid }) {
  return db.runTransaction(async (tx) => {
    await activeProfile(tx, db, uid);
    const rows = await tx.get(db.collection("problems").where("status", "==", "moderated_removed").limit(51));
    return { items: rows.docs.slice(0, 50).map(redactedProblem), truncated: rows.size > 50 };
  });
}

/** One removed problem, safe for any member to open. Hidden problems stay unavailable. */
export async function readRemovedProblem({ db, uid, problemId }) {
  validateContent("problem", problemId);
  return db.runTransaction(async (tx) => {
    await activeProfile(tx, db, uid);
    const parent = await tx.get(db.collection("problems").doc(problemId));
    if (!parent.exists || parent.data().moderationStatus !== "removed") fail("not-found", "This opportunity is not available.");
    return redactedProblem(parent);
  });
}

export async function listPostedProposals({ db, uid, problemId }) {
  validateContent("problem", problemId);
  return db.runTransaction(async (tx) => {
    const profile = await activeProfile(tx, db, uid);
    const parent = await tx.get(db.collection("problems").doc(problemId));
    if (!parent.exists) fail("permission-denied", "This opportunity is not available.");
    if (parent.data().moderationStatus === "removed") {
      const rows = await tx.get(db.collection("proposals").where("problemId", "==", problemId).limit(POSTED_PROPOSAL_CAP + 1));
      const fallback = { reason: parent.data().moderation?.reason || "", details: parent.data().moderation?.details || "" };
      return {
        removedParent: true,
        items: rows.docs.filter(parentRemovalClaim).slice(0, POSTED_PROPOSAL_CAP).map((doc) => redactedProposal(doc, fallback)),
        truncated: rows.size > POSTED_PROPOSAL_CAP,
      };
    }
    if (!await canReadContent(tx, db, "problem", parent.data(), uid, profile)) {
      fail("permission-denied", "This opportunity is not available.");
    }
    const [rows, removedRows] = await Promise.all([
      tx.get(db.collection("proposals").where("problemId", "==", problemId)
        .where("status", "in", MEMBER_VISIBLE_PROPOSAL).limit(POSTED_PROPOSAL_CAP + 1)),
      tx.get(db.collection("proposals").where("problemId", "==", problemId)
        .where("status", "==", "moderated_removed").limit(POSTED_PROPOSAL_CAP + 1)),
    ]);
    const problemBrowsable = problemIsMemberBrowsable(parent.data());
    const visible = rows.docs.filter((doc) => !BLOCKED.has(doc.data().moderationStatus)
      || owner("proposal", doc.data()) === uid || profile.role === 1);
    for (const doc of rows.docs.slice(0, POSTED_PROPOSAL_CAP)) stampProposalBrowsable(tx, doc, problemBrowsable, Timestamp.now());
    const removed = removedRows.docs.map((doc) => redactedProposal(doc));
    return {
      items: [...visible.slice(0, POSTED_PROPOSAL_CAP).map((doc) => ({ id: doc.id, ...serialise(doc.data()), problemBrowsable })), ...removed],
      truncated: rows.size > POSTED_PROPOSAL_CAP || removedRows.size > POSTED_PROPOSAL_CAP,
    };
  });
}
