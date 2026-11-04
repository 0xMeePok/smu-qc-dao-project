import { Timestamp } from "firebase-admin/firestore";
import { isIndependentProposal } from "./independentProposal.js";
import { moderationVoidReasonHash } from "./escrowModerationVoid.js";

export const INDEPENDENT_FUNDING_CANCELLATIONS = "independentFundingCancellationJobs";

/** The removal transaction uses its unique decision id to persist recovery work. */
export function queueIndependentFundingCancellation(tx, db, { contentId, eventId, reason, now }) {
  tx.set(db.collection(INDEPENDENT_FUNDING_CANCELLATIONS).doc(`${eventId}_${contentId}`), {
    proposalId: contentId, eventId, reasonHash: moderationVoidReasonHash(eventId, reason || ""),
    status: "pending", nextAttemptAt: now, createdAt: now, updatedAt: now,
  });
}

/** Queue the dedicated listing escrow after a server-recorded removal. */
export async function enqueueIndependentFundingCancellation({ db, contentType, contentId, eventId, reason, now = Timestamp.now() }) {
  if (contentType !== "proposal" || !contentId || !eventId) return { enqueued: 0 };
  const proposalRef = db.collection("proposals").doc(contentId);
  const eventRef = db.collection("moderationEvents").doc(eventId);
  const jobRef = db.collection(INDEPENDENT_FUNDING_CANCELLATIONS).doc(`${eventId}_${contentId}`);
  return db.runTransaction(async tx => {
    const [proposal, event, job] = await Promise.all([tx.get(proposalRef), tx.get(eventRef), tx.get(jobRef)]);
    if (!proposal.exists || !isIndependentProposal(proposal.data()) || !event.exists
        || event.data().action !== "remove" || event.data().contentType !== "proposal"
        || event.data().contentId !== contentId) return { enqueued: 0 };
    if (!job.exists) queueIndependentFundingCancellation(tx, db, {
      contentId, eventId, reason: event.data().reason || reason, now,
    });
    tx.set(eventRef, { ...event.data(), independentFundingCancellation: {
      ...(event.data().independentFundingCancellation || {}), status: job.data()?.status || "queued",
    } });
    return { enqueued: job.exists ? 0 : 1 };
  });
}
