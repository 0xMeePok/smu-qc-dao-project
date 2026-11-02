import { Timestamp } from "firebase-admin/firestore";
import { memberNoticeFields } from "./moderation.js";
import { WORKFLOW_STATUS } from "./workflowStatus.js";

/**
 * Independent crowdfunding has no posting owner. When the researcher submits
 * completion evidence, each funder who still has money in the escrow needs a
 * notice that their vote is due. Deterministic ids keep trigger retries from
 * duplicating a notice or clearing one already read.
 */
const ADDRESS = /^0x[0-9a-f]{40}$/;
const lower = (value) => String(value ?? "").trim().toLowerCase();
const amount = (value) => { try { return BigInt(value || 0); } catch { return 0n; } };

function deadlineText(summary) {
  const seconds = Number(summary?.completionDeadline);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return "before the completion deadline shown on the listing";
  return `by ${new Date(seconds * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC")}`;
}

/** Funders with a live deposit, excluding the researcher who filed the evidence. */
export function independentEvidenceRecipients(positions, { actorId, researcherId, config }) {
  const actor = lower(actorId), researcher = lower(researcherId), seen = new Set();
  const factory = lower(config?.independentFunding?.factoryAddress);
  const registry = lower(config?.address);
  return positions.flatMap((position) => {
    const recipientId = lower(position?.walletId);
    if (!ADDRESS.test(recipientId) || recipientId === actor || recipientId === researcher || seen.has(recipientId)) return [];
    if (position.chainId !== config?.chainId || lower(position.registryAddress) !== registry
      || lower(position.factoryAddress) !== factory || amount(position.deposited) <= 0n) return [];
    seen.add(recipientId);
    return [recipientId];
  });
}

export function independentEvidenceNotice({ recipientId, proposalId, title, summary }) {
  const name = `“${String(title || "Independent listing").slice(0, 160)}”`;
  return {
    recipientId,
    title: "Completion evidence to review",
    workflowStatus: WORKFLOW_STATUS.ACCEPTED,
    message: `The researcher submitted completion evidence for ${name}. Review it and vote ${deadlineText(summary)}. A majority yes releases the remaining 50%.`,
    navigationTarget: `proposal/${proposalId}?tab=funding`,
  };
}

export async function notifyIndependentEvidenceSubmitted({ db, config, eventId, event, now = Timestamp.now() }) {
  if (!event || event.eventType !== "EvidenceSubmitted" || typeof eventId !== "string" || !event.proposalId) return { delivered: 0 };
  if (!config?.independentFunding?.factoryAddress) return { delivered: 0 };
  const proposal = await db.collection("proposals").doc(event.proposalId).get();
  if (!proposal.exists) return { delivered: 0 };
  const record = proposal.data();
  if (record.moderated || ["hidden", "removed"].includes(record.moderationStatus)
    || ["draft", "withdrawn", "cancelled", "moderated_removed"].includes(record.status)) return { delivered: 0 };
  const summaryId = event.summaryKey || `${config.chainId}_${lower(config.address)}_${event.proposalId}`;
  const summarySnap = await db.collection("independentFundingSummaries").doc(summaryId).get();
  const summary = summarySnap.exists ? summarySnap.data() : null;
  if (!summary || summary.state !== "Accepted") return { delivered: 0 };
  const rows = await db.collection("independentFundingPositions").where("proposalId", "==", event.proposalId).limit(100).get();
  const notices = independentEvidenceRecipients(rows.docs.map((doc) => doc.data()), {
    actorId: event.actorId, researcherId: record.researcherId || event.researcherId, config,
  }).map((recipientId) => independentEvidenceNotice({ recipientId, proposalId: event.proposalId, title: record.title, summary }));
  if (!notices.length) return { delivered: 0 };
  const createdAt = Number.isSafeInteger(event.timestamp) && event.timestamp > 0 ? Timestamp.fromMillis(event.timestamp * 1000) : now;
  return db.runTransaction(async (tx) => {
    const refs = notices.map((notice) => db.collection("moderationNotifications").doc(`independent_evidence_${eventId}_${notice.recipientId}`));
    const existing = await Promise.all(refs.map((ref) => tx.get(ref)));
    let delivered = 0;
    refs.forEach((ref, index) => {
      if (existing[index].exists) return;
      const notice = notices[index];
      tx.set(ref, { ...memberNoticeFields({ recipientId: notice.recipientId, now, createdAt, kind: "independent_funding",
        workflowStatus: notice.workflowStatus, contentType: "proposal", contentId: event.proposalId,
        proposalId: event.proposalId, title: notice.title, message: notice.message, navigationTarget: notice.navigationTarget }),
      eventId, independentEventType: event.eventType, transactionHash: event.transactionHash ?? null });
      delivered += 1;
    });
    return { delivered };
  });
}
