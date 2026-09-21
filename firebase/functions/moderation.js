import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

export const REPORT_REASONS = ["off_topic", "abusive", "misleading", "duplicate", "other"];
export const MODERATION_REASONS = [...REPORT_REASONS, "spam", "policy_violation", "no_violation", "appeal_accepted"];
const TYPES = { problem: "problems", proposal: "proposals", comment: "comments" };
const ACTION_STATUS = { hide: "hidden", remove: "removed", restore: "restored" };
const BLOCKED = new Set(["hidden", "removed"]);
const PAGE_SIZE = 50;
const MEMBER_VISIBLE_PROPOSAL = ["submitted", "under_review", "accepted", "rejected", "withdrawn"];
const POSTED_PROPOSAL_CAP = 200;
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
    title: String(fields.title || "").slice(0, 160), message: fields.message,
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
    kind: "proposal_received", contentType: "proposal", contentId: proposalId, proposalId,
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

export async function syncProblemProposalsBrowsable({ db, problemId, now = Timestamp.now() }) {
  return db.runTransaction(async (tx) => {
    const parent = await tx.get(db.collection("problems").doc(problemId));
    if (!parent.exists) return { ok: true };
    const problemBrowsable = problemIsMemberBrowsable(parent.data());
    const rows = await tx.get(db.collection("proposals").where("problemId", "==", problemId)
      .where("status", "in", MEMBER_VISIBLE_PROPOSAL).limit(POSTED_PROPOSAL_CAP + 1));
    for (const doc of rows.docs.slice(0, POSTED_PROPOSAL_CAP)) stampProposalBrowsable(tx, doc, problemBrowsable, now);
    return { ok: true };
  });
}

export async function canReadContent(tx, db, type, data, uid, profile) {
  if (profile.role === 1 || owner(type, data) === uid) return true;
  if (BLOCKED.has(data.moderationStatus) || !isPublished(type, data)) return false;
  if (type === "problem") return ["submitted", "open", "cancelled", "expired"].includes(data.status);
  if (type === "proposal") {
    if (data.postingOwnerId === uid) return true;
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
    excerpt: excerpt(data), authorId: owner(type, data) || "", authorName: authorProfile?.fullName || "",
    organisation: data.organisation || authorProfile?.organisation || "", contentCreatedAt: data.createdAt || null,
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

/** Re-read current content so delayed/retried trigger delivery cannot restore a stale queue. */
export async function flagSubmittedContent({ db, contentType, contentId, now = Timestamp.now() }) {
  const queueId = validateContent(contentType, contentId);
  return db.runTransaction(async (tx) => {
    const ref = db.collection(TYPES[contentType]).doc(contentId);
    const queueRef = db.collection("moderationQueue").doc(queueId);
    const statsRef = db.collection("moderationStats").doc("global");
    const [content, queue, stats] = await Promise.all([tx.get(ref), tx.get(queueRef), tx.get(statsRef)]);
    if (!content.exists || !isPublished(contentType, content.data()) || BLOCKED.has(content.data().moderationStatus)) return { flagged: false };
    const data = content.data(), flags = moderationFlags(data);
    if (!flags.length) return { flagged: false };
    const fingerprint = hash(JSON.stringify([data.title || "", excerpt(data), flags]));
    const previous = queue.data();
    if (previous?.flagFingerprint === fingerprint) return { flagged: false };
    const authorId = owner(contentType, data);
    const author = authorId ? await tx.get(db.collection("users").doc(authorId)) : null;
    tx.set(queueRef, { ...queueRecord(contentType, contentId, data, author?.data(), previous),
      status: "pending", ruleFlags: flags, flagFingerprint: fingerprint, createdAt: previous?.createdAt || now, updatedAt: now });
    writeStats(tx, statsRef, stats, pendingDelta(previous, "pending"), now);
    return { flagged: true, queueId };
  });
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
    tx.set(reportRef, { queueId, contentType, contentId, reporterId: uid, reason, details: note, createdAt: now });
    tx.set(queueRef, { ...queueRecord(contentType, contentId, data, author?.data(), previous), status,
      reportCount, sortReports: -reportCount, reportReasons: { ...previous?.reportReasons, [reason]: (previous?.reportReasons?.[reason] || 0) + 1 },
      createdAt: previous?.createdAt || now, updatedAt: now });
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
    const items = rows.docs.slice(0, PAGE_SIZE).map((doc) => ({ id: doc.id, ...serialise(doc.data()), reasons: Object.keys(doc.data().reportReasons || {}) }));
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
  if (!Object.hasOwn(ACTION_STATUS, action) || !MODERATION_REASONS.includes(reason)) fail("invalid-argument", "Choose a moderation action and reason.");
  const note = validDetails(details);
  return db.runTransaction(async (tx) => {
    await activeProfile(tx, db, uid, true);
    const ref = db.collection(TYPES[contentType]).doc(contentId);
    const queueRef = db.collection("moderationQueue").doc(queueId);
    const statsRef = db.collection("moderationStats").doc("global");
    const [content, queue, stats] = await Promise.all([tx.get(ref), tx.get(queueRef), tx.get(statsRef)]);
    if (!content.exists || !queue.exists || !isPublished(contentType, content.data())) fail("not-found", "Published moderation content not found.");
    const data = content.data(), previous = queue.data();
    if (previous.status === ACTION_STATUS[action] && data.moderation?.lastAction === action && data.moderation.reason === reason && data.moderation.details === note) return { ok: true, unchanged: true };
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
    tx.update(ref, { status: action === "restore" ? previousStatus : `moderated_${ACTION_STATUS[action]}`,
      moderationStatus: action === "restore" ? "visible" : ACTION_STATUS[action], moderation,
      ...(contentType === "proposal" ? { postingOwnerId: action === "restore" ? originalPostingOwnerId || "" : "" } : {}),
      ...(commentGate ? { qualifying: commentGate.qualifying } : {}), updatedAt: now });
    tx.update(queueRef, { status: ACTION_STATUS[action], lastAction: action, lastReason: reason, updatedAt: now });
    writeStats(tx, statsRef, stats, pendingDelta(previous, ACTION_STATUS[action]), now);
    tx.set(db.collection("moderationEvents").doc(eventId), {
      queueId, contentType, contentId, action, reason, details: note, actorId: uid, authorId: authorId || "",
      previousVisibility: data.moderationStatus || "visible", visibility: action === "restore" ? "visible" : ACTION_STATUS[action],
      createdAt: now, sequence, chainStatus: "pending", eventVersion: 1, settlement: settlement?.summary || null,
    });
    if (authorId) {
      const proposalId = contentType === "proposal" ? contentId : data.proposalId || null;
      const problemId = contentType === "problem" ? contentId : data.problemId || null;
      const navigationTarget = notificationNavigationTarget({ contentType, contentId, proposalId, problemId });
      tx.set(db.collection("moderationNotifications").doc(`${eventId}_${authorId}`), {
        recipientId: authorId, queueId, contentType, contentId, title: String(data.title || "Your comment").slice(0, 160),
        action, reason, details: note, createdAt: now, readAt: null,
        ...(problemId ? { problemId } : {}), ...(proposalId ? { proposalId } : {}),
        ...(navigationTarget ? { navigationTarget, link: `#/${navigationTarget}` } : {}),
      });
    }
    return { ok: true, eventId, status: ACTION_STATUS[action] };
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

async function loadCommentReplies(tx, db, parentIds) {
  if (!parentIds.length) return [];
  const pages = await Promise.all(Array.from({ length: Math.ceil(parentIds.length / 10) }, (_, index) =>
    tx.get(db.collection("comments").where("parentId", "in", parentIds.slice(index * 10, index * 10 + 10)))));
  return pages.flatMap((page) => page.docs).sort((a, b) => {
    const at = a.data().createdAt?.toMillis?.() ?? 0, bt = b.data().createdAt?.toMillis?.() ?? 0;
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export async function listReportableComments({ db, uid, problemId, proposalId, cursor, sort }) {
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
    const direction = newest ? "desc" : "asc";
    let query = db.collection("comments").where(proposalId ? "proposalId" : "problemId", "==", parentId);
    if (proposalId) query = query.where("parentId", "==", null);
    query = query.orderBy("createdAt", direction).orderBy("__name__", direction);
    if (cursor) query = query.startAfter(cursorTimestamp(cursor), cursor.id);
    const rows = await tx.get(query.limit(101));
    const page = rows.docs.slice(0, 100);
    const visible = page.filter((doc) => commentVisible(doc.data(), { uid, profile, proposalScoped: Boolean(proposalId) }));
    const replyDocs = proposalId ? await loadCommentReplies(tx, db, visible.map((doc) => doc.id)) : [];
    const visibleReplies = replyDocs.filter((doc) => commentVisible(doc.data(), { uid, profile, proposalScoped: true }));
    const authorIds = [...new Set([...visible, ...visibleReplies].map((doc) => owner("comment", doc.data()) || "").filter(Boolean))];
    const names = new Map();
    await Promise.all(authorIds.map(async (id) => {
      const publicProfile = await tx.get(db.collection("publicProfiles").doc(id));
      names.set(id, publicProfile.data()?.fullName || "");
    }));
    const repliesByParent = new Map();
    for (const doc of visibleReplies) {
      const replyParentId = doc.data().parentId;
      if (!repliesByParent.has(replyParentId)) repliesByParent.set(replyParentId, []);
      repliesByParent.get(replyParentId).push(commentListItem(doc, names));
    }
    const items = visible.map((doc) => {
      const item = commentListItem(doc, names);
      return proposalId ? { ...item, replies: repliesByParent.get(doc.id) || [] } : item;
    });
    const last = page.at(-1);
    if (parentType === "proposal") {
      const problem = parent.data().problemId
        ? await tx.get(db.collection("problems").doc(parent.data().problemId)) : null;
      stampProposalBrowsable(tx, parent, problemIsMemberBrowsable(problem?.exists ? problem.data() : null), Timestamp.now());
    }
    return { items, truncated: rows.size > 100,
      nextCursor: rows.size > 100 ? timestampCursor(last.id, last.data().createdAt) : null };
  });
}

export async function listPostedProposals({ db, uid, problemId }) {
  validateContent("problem", problemId);
  return db.runTransaction(async (tx) => {
    const profile = await activeProfile(tx, db, uid);
    const parent = await tx.get(db.collection("problems").doc(problemId));
    if (!parent.exists || !await canReadContent(tx, db, "problem", parent.data(), uid, profile)) {
      fail("permission-denied", "This opportunity is not available.");
    }
    const rows = await tx.get(db.collection("proposals").where("problemId", "==", problemId)
      .where("status", "in", MEMBER_VISIBLE_PROPOSAL).limit(POSTED_PROPOSAL_CAP + 1));
    const problemBrowsable = problemIsMemberBrowsable(parent.data());
    const visible = rows.docs.filter((doc) => !BLOCKED.has(doc.data().moderationStatus)
      || owner("proposal", doc.data()) === uid || profile.role === 1);
    for (const doc of rows.docs.slice(0, POSTED_PROPOSAL_CAP)) stampProposalBrowsable(tx, doc, problemBrowsable, Timestamp.now());
    return {
      items: visible.slice(0, POSTED_PROPOSAL_CAP).map((doc) => ({ id: doc.id, ...serialise(doc.data()), problemBrowsable })),
      truncated: rows.size > POSTED_PROPOSAL_CAP,
    };
  });
}
