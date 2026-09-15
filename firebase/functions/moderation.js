import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

export const REPORT_REASONS = ["off_topic", "abusive", "misleading", "duplicate", "other"];
export const MODERATION_REASONS = [...REPORT_REASONS, "spam", "policy_violation", "no_violation", "appeal_accepted"];
const TYPES = { problem: "problems", proposal: "proposals", comment: "comments" };
const ACTION_STATUS = { hide: "hidden", remove: "removed", restore: "restored" };
const BLOCKED = new Set(["hidden", "removed"]);
const PAGE_SIZE = 50;
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
async function canReadContent(tx, db, type, data, uid, profile) {
  if (profile.role === 1 || owner(type, data) === uid) return true;
  if (BLOCKED.has(data.moderationStatus) || !isPublished(type, data)) return false;
  if (type === "problem") return ["submitted", "open", "cancelled"].includes(data.status);
  if (type === "proposal") return data.postingOwnerId === uid;
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

export async function moderateContent({ db, uid, queueId, action, reason, details, prepareMatching, now = Timestamp.now() }) {
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
    const hidden = BLOCKED.has(data.moderationStatus);
    const previousStatus = hidden ? data.moderation.previousStatus : data.status || "submitted";
    const originalPostingOwnerId = hidden ? data.moderation?.originalPostingOwnerId : data.postingOwnerId;
    const moderation = { ...data.moderation, previousStatus, lastAction: action, reason, details: note, moderatorId: uid, moderatedAt: now, sequence };
    if (contentType === "proposal") moderation.originalPostingOwnerId = originalPostingOwnerId || "";
    settlement?.apply?.();
    tx.update(ref, { status: action === "restore" ? previousStatus : `moderated_${ACTION_STATUS[action]}`,
      moderationStatus: action === "restore" ? "visible" : ACTION_STATUS[action], moderation,
      ...(contentType === "proposal" ? { postingOwnerId: action === "restore" ? originalPostingOwnerId || "" : "" } : {}), updatedAt: now });
    tx.update(queueRef, { status: ACTION_STATUS[action], lastAction: action, lastReason: reason, updatedAt: now });
    writeStats(tx, statsRef, stats, pendingDelta(previous, ACTION_STATUS[action]), now);
    tx.set(db.collection("moderationEvents").doc(eventId), {
      queueId, contentType, contentId, action, reason, details: note, actorId: uid, authorId: authorId || "",
      previousVisibility: data.moderationStatus || "visible", visibility: action === "restore" ? "visible" : ACTION_STATUS[action],
      createdAt: now, sequence, chainStatus: "pending", eventVersion: 1, settlement: settlement?.summary || null,
    });
    if (authorId) tx.set(db.collection("moderationNotifications").doc(`${eventId}_${authorId}`), {
      recipientId: authorId, queueId, contentType, contentId, title: String(data.title || "Your comment").slice(0, 160),
      action, reason, details: note, createdAt: now, readAt: null,
    });
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

export async function listReportableComments({ db, uid, problemId, proposalId, cursor }) {
  const parentType = proposalId ? "proposal" : "problem", parentId = proposalId || problemId;
  validateContent(parentType, parentId);
  if (cursor) {
    validateContent("comment", cursor.id);
    cursorTimestamp(cursor);
  }
  return db.runTransaction(async (tx) => {
    const profile = await activeProfile(tx, db, uid);
    const parent = await tx.get(db.collection(TYPES[parentType]).doc(parentId));
    if (!parent.exists || !await canReadContent(tx, db, parentType, parent.data(), uid, profile)) fail("permission-denied", "This discussion is not available.");
    if (proposalId && problemId && parent.data().problemId !== problemId) fail("permission-denied", "This proposal does not belong to that problem.");
    let query = db.collection("comments").where(proposalId ? "proposalId" : "problemId", "==", parentId).orderBy("createdAt").orderBy("__name__");
    if (cursor) query = query.startAfter(cursorTimestamp(cursor), cursor.id);
    const rows = await tx.get(query.limit(101));
    const page = rows.docs.slice(0, 100);
    const items = page.filter((doc) => (proposalId || !doc.data().proposalId) && isPublished("comment", doc.data())
      && (!BLOCKED.has(doc.data().moderationStatus) || owner("comment", doc.data()) === uid || profile.role === 1))
      .map((doc) => {
        const data = doc.data();
        return { id: doc.id, authorId: owner("comment", data) || "", problemId: data.problemId || null,
          proposalId: data.proposalId || null, body: String(data.body || data.text || data.content || ""),
          createdAt: serialise(data.createdAt || null), moderationStatus: data.moderationStatus || "visible",
          moderation: serialise(data.moderation || null) };
      });
    const last = page.at(-1);
    return { items, truncated: rows.size > 100,
      nextCursor: rows.size > 100 ? timestampCursor(last.id, last.data().createdAt) : null };
  });
}
