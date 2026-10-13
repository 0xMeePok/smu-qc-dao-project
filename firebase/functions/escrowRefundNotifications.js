import { Timestamp } from "firebase-admin/firestore";
import { memberNoticeFields } from "./moderation.js";

export const REFUND_NOTIFICATION_JOBS = "escrowRefundNotificationJobs";
const instant = value => Timestamp.fromMillis(value);
const descriptions = {
  funding_target_not_met: "The funding target was not reached before the posting expired.",
  no_proposal_selected: "The posting expired without a proposal selection.",
  selection_approval_timeout: "The selected proposal's seven-day approval window elapsed.",
  completion_approval_timeout: "The completion approval window elapsed.",
  selection_declined: "The selected proposal was declined.",
  cancelled: "The escrow was cancelled.",
  registry_invalidated: "The posting or proposal was withdrawn, or another proposal was accepted.",
  escrow_voided: "The escrow was cancelled by an authorized administrator.",
  admin_cancelled: "An administrator cancelled the unpaid escrow.",
  posting_expired: "The posting window elapsed.",
};

/** A cursor persists notification progress beyond the per-run budget. Repeated
 * deposits and retries share deterministic notice ids and retain read state. */
export async function deliverRefundNotifications({ db, config, eventId, now = Timestamp.now() }) {
  const ref = db.collection(REFUND_NOTIFICATION_JOBS).doc(eventId), saved = await ref.get(), job = saved.data();
  if (!saved.exists || job.status !== "pending" || job.registryAddress !== config.address.toLowerCase() || job.chainId !== config.chainId) return 0;
  let query = db.collection("escrowFundingEvents").where("proposalId", "==", job.proposalId)
    .where("registryAddress", "==", job.registryAddress).where("eventType", "==", "Deposit").orderBy("__name__").limit(100);
  if (job.cursor) query = query.startAfter(job.cursor);
  const page = await query.get();
  const recipients = [...new Set(page.docs.map(doc => doc.data()).filter(event => event.verified === true
    && event.chainId === job.chainId && /^0x[0-9a-f]{40}$/i.test(event.actor ?? "")).map(event => event.actor.toLowerCase()))];
  return db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (current.data()?.status !== "pending" || (current.data().cursor ?? null) !== (job.cursor ?? null)) return 0;
    const refs = recipients.map(recipient => db.collection("moderationNotifications").doc(`${eventId}_${recipient}`));
    const existing = await Promise.all(refs.map(notice => tx.get(notice)));
    refs.forEach((notice, index) => {
      if (existing[index].exists) return;
      const available = BigInt(job.refundAvailableAt ?? "0") * 1000n <= BigInt(now.toMillis());
      tx.set(notice, { ...memberNoticeFields({ recipientId: recipients[index], now,
        createdAt: instant(job.timestamp * 1000), kind: "escrow", contentType: "proposal", contentId: job.proposalId,
        proposalId: job.proposalId, problemId: job.problemId ?? null, title: available ? "Escrow refund available" : "Escrow refund scheduled",
        message: `${descriptions[job.refundReason] ?? "Refunds have opened for this escrow."} ${available
          ? "Claim your confirmed refundable balance from the escrow. Each funder claims their own balance; no refund fee is charged."
          : `The confirmed refund becomes claimable at ${new Date(Number(job.refundAvailableAt) * 1000).toISOString()}. No refund fee is charged.`}`,
      }), eventId, transactionHash: job.transactionHash, registryAddress: job.registryAddress,
      refundReason: job.refundReason, refundAvailableAt: job.refundAvailableAt });
    });
    tx.set(ref, { ...current.data(), cursor: page.size === 100 ? page.docs.at(-1).id : null,
      status: page.size === 100 ? "pending" : "complete", nextAttemptAt: now, updatedAt: now });
    return recipients.length;
  });
}

export async function sweepRefundNotifications({ db, config, now = Timestamp.now() }) {
  const page = await db.collection(REFUND_NOTIFICATION_JOBS).where("registryAddress", "==", config.address.toLowerCase())
    .where("status", "==", "pending").where("nextAttemptAt", "<=", now).orderBy("nextAttemptAt").limit(10).get();
  for (const row of page.docs) {
    try { await deliverRefundNotifications({ db, config, eventId: row.id, now }); }
    catch { /* The immutable event and cursor remain pending for the next sweep. */ }
  }
}
