import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { keccak256, stringToHex } from "viem";
import { isIndependentProposal } from "./independentProposal.js";

export const VOID_JOBS = "escrowModerationVoidJobs";
export const VOID_ENUMERATIONS = "escrowModerationVoidEnumerations";
export const VOID_ENUMERATION_PAGE = 100;
const POSTED_STATUSES = ["submitted", "under_review", "accepted", "rejected", "withdrawn", "moderated_removed", "moderated_hidden"];
const TERMINAL = new Set(["Released", "Refunded", "Voided", "Cancelled", "Expired"]);
const OPENABLE = new Set(["Open", "Locked", "Active"]);

export function moderationVoidReasonHash(eventId, reason) {
  return keccak256(stringToHex(`${eventId}:${reason || ""}`));
}

export function voidDecision(state, isAdmin) {
  if (!isAdmin) return { outcome: "awaiting-admin" };
  if (TERMINAL.has(state)) return { outcome: "skipped", skipReason: state };
  if (OPENABLE.has(state)) return { outcome: "void" };
  return { outcome: "skipped", skipReason: state || "unknown" };
}

export function moderationVoidJobId(eventId, proposalId) {
  return `${eventId}_${proposalId}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 700);
}

/** Persisted in the removal transaction, so a failed callable cannot lose work. */
export function queueModerationVoidEnumeration(tx, db, { contentType, contentId, eventId, reason, now }) {
  tx.set(db.collection(VOID_ENUMERATIONS).doc(eventId), {
    contentType, contentId, eventId, reason: reason || "", status: "pending",
    cursor: null, enqueued: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
  });
}

/** Queue at most one page. Cursor and jobs commit together; retries cannot skip a page. */
export async function enqueueModerationVoidJobs({ db, contentType, contentId, eventId, reason, now = Timestamp.now() }) {
  if (!eventId || !contentId || (contentType !== "proposal" && contentType !== "problem")) return { enqueued: 0 };
  return db.runTransaction(async (tx) => {
    const eventRef = db.collection("moderationEvents").doc(eventId);
    const enumerationRef = db.collection(VOID_ENUMERATIONS).doc(eventId);
    const [event, enumeration] = await Promise.all([tx.get(eventRef), tx.get(enumerationRef)]);
    // Only the immutable server decision can authorize jobs or determine their reason.
    if (!event.exists || event.data().action !== "remove" || event.data().contentType !== contentType
        || event.data().contentId !== contentId) return { enqueued: 0 };
    const progress = enumeration.data() || {};
    if (progress.status === "complete") return { enqueued: 0, complete: true };
    const reasonText = event.data().reason || "";
    const reasonHash = moderationVoidReasonHash(eventId, reasonText);
    let docs, more = false;
    if (contentType === "proposal") {
      const doc = await tx.get(db.collection("proposals").doc(contentId));
      if (doc.exists && isIndependentProposal(doc.data())) return { enqueued: 0 };
      docs = doc.exists ? [doc] : [];
    } else {
      let query = db.collection("proposals").where("problemId", "==", contentId)
        .where("status", "in", POSTED_STATUSES).orderBy(FieldPath.documentId())
        .select("status", "fundingTerms", "problemId", "proposalKind").limit(VOID_ENUMERATION_PAGE + 1);
      if (progress.cursor) query = query.startAfter(progress.cursor);
      const rows = await tx.get(query);
      more = rows.size > VOID_ENUMERATION_PAGE;
      docs = rows.docs.slice(0, VOID_ENUMERATION_PAGE);
    }
    const targets = docs.filter((doc) => doc.data().status !== "draft" && doc.data().fundingTerms
      && !isIndependentProposal(doc.data()) && doc.data().problemId)
      .map((doc) => ({ id: doc.id, problemId: doc.data().problemId }));
    const refs = targets.map((target) => db.collection(VOID_JOBS).doc(moderationVoidJobId(eventId, target.id)));
    const jobs = await Promise.all(refs.map((ref) => tx.get(ref)));
    let enqueued = 0;
    jobs.forEach((snap, index) => {
      if (snap.exists) return;
      enqueued++;
      const target = targets[index];
      tx.set(snap.ref, {
        proposalId: target.id, problemId: target.problemId, eventId, reason: reasonText, reasonHash,
        status: "pending", nextAttemptAt: now, createdAt: now, updatedAt: now,
      });
    });
    const total = (progress.enqueued || 0) + enqueued;
    tx.set(enumerationRef, { ...progress, contentType, contentId, eventId, reason: reasonText,
      status: more ? "pending" : "complete", cursor: docs.at(-1)?.id || progress.cursor || null,
      enqueued: total, nextAttemptAt: now, createdAt: progress.createdAt || now, updatedAt: now });
    tx.set(eventRef, { ...event.data(), escrowVoid: {
      status: "queued", enumerationComplete: !more, enqueuedCount: total,
    } });
    return { enqueued, complete: !more };
  });
}

/** Scheduled worker resumes failed/large enumerations without another moderator action. */
export async function reconcileModerationVoidEnumerations({ db, now = Timestamp.now() }) {
  const rows = await db.collection(VOID_ENUMERATIONS).where("status", "==", "pending")
    .where("nextAttemptAt", "<=", now).orderBy("nextAttemptAt").limit(3).get();
  for (const row of rows.docs) {
    try { await enqueueModerationVoidJobs({ db, ...row.data(), now }); }
    catch { await row.ref.update({ nextAttemptAt: Timestamp.fromMillis(now.toMillis() + 60_000), updatedAt: now }); }
  }
}
