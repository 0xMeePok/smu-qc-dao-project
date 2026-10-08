import { Timestamp } from "firebase-admin/firestore";
import { keccak256, stringToHex } from "viem";
import { isIndependentProposal } from "./independentProposal.js";

export const VOID_JOBS = "escrowModerationVoidJobs";
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

/** Queue one voidEscrow job per linked proposal escrow. An independent listing uses its own id as the parent reference. */
export async function enqueueModerationVoidJobs({ db, contentType, contentId, eventId, reason, now = Timestamp.now() }) {
  if (!eventId || !contentId || (contentType !== "proposal" && contentType !== "problem")) return { enqueued: 0 };
  const reasonHash = moderationVoidReasonHash(eventId, reason);
  let targets = [];
  if (contentType === "proposal") {
    const doc = await db.collection("proposals").doc(contentId).get();
    const data = doc.exists ? doc.data() : null;
    if (data?.fundingTerms && !isIndependentProposal(data) && data.problemId) targets = [{ id: doc.id, problemId: data.problemId }];
  } else {
    const rows = await db.collection("proposals").where("problemId", "==", contentId).limit(201).get();
    targets = rows.docs.filter((doc) => doc.data()?.fundingTerms && !isIndependentProposal(doc.data()))
      .map((doc) => ({ id: doc.id, problemId: contentId }));
  }
  if (!targets.length) return { enqueued: 0 };
  await db.runTransaction(async (tx) => {
    const eventRef = db.collection("moderationEvents").doc(eventId);
    const refs = targets.map((target) => db.collection(VOID_JOBS).doc(moderationVoidJobId(eventId, target.id)));
    const [event, ...jobs] = await Promise.all([tx.get(eventRef), ...refs.map((ref) => tx.get(ref))]);
    jobs.forEach((snap, index) => {
      if (snap.exists) return;
      const target = targets[index];
      tx.set(snap.ref, {
        proposalId: target.id, problemId: target.problemId, eventId, reason: reason || "", reasonHash,
        status: "pending", nextAttemptAt: now, createdAt: now, updatedAt: now,
      });
    });
    if (event.exists) {
      tx.set(eventRef, {
        ...event.data(),
        escrowVoid: { ...(event.data().escrowVoid || {}), status: "queued", proposalIds: targets.map((item) => item.id) },
      });
    }
  });
  return { enqueued: targets.length };
}
