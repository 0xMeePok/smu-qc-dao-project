import { Timestamp } from "firebase-admin/firestore";
import { memberNoticeFields } from "./moderation.js";
import { WORKFLOW_STATUS } from "./workflowStatus.js";

/**
 * QCDAO-68. Escrow-backed selection happens on chain, so the mock matching
 * notices (matchingNotifications.js) never fire for it, and saveEvent only
 * notified the two parties of tranche releases; refund notices go to
 * depositors. Without this, a researcher whose proposal was selected had no
 * in-platform notice that a seven-day approval window had started, and was not
 * told when the selection was rejected or the escrow cancelled.
 *
 * Runs once per verified, immutable escrowFundingEvents record. Deterministic
 * ids keep retries idempotent and preserve read state. Admin cancellations
 * and tranche releases already have their own notices.
 */
const ADDRESS = /^0x[0-9a-f]{40}$/;
const lower = (value) => String(value ?? "").trim().toLowerCase();
const S = WORKFLOW_STATUS;

function deadlineText(event) {
  const seconds = Number(event.deadlineAt);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return "before the approval deadline shown on the escrow";
  return `by ${new Date(seconds * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC")}`;
}

const ENDED = {
  SelectionInvalidated: "The selection was rejected",
  Cancelled: "The escrow was cancelled",
  Expired: "The escrow expired",
  Voided: "The escrow was voided",
};

/** Who hears about an escrow event, and what they are told. Pure for tests. */
export function escrowWorkflowNotices(event = {}, { researcherId, ownerId, title } = {}) {
  const researcher = lower(researcherId), owner = lower(ownerId), actor = lower(event.actor);
  const name = `“${String(title || "Proposal").slice(0, 160)}”`;
  const notices = [];
  const add = (recipientId, notice) => {
    if (!ADDRESS.test(recipientId) || recipientId === actor) return;
    if (notices.some((item) => item.recipientId === recipientId)) return;
    notices.push({ recipientId, ...notice });
  };
  switch (event.eventType) {
    case "SelectionLocked":
      add(researcher, { title: "Your proposal was selected", workflowStatus: S.SELECTED,
        message: `The posting owner selected your proposal ${name} and approved the escrow. Approve the upfront payment ${deadlineText(event)} to confirm the match. You may reject instead; rejection refunds its contributors.` });
      add(owner, { title: "Proposal selected", workflowStatus: S.PENDING_APPROVAL,
        message: `${name} was selected. Its researcher must approve the upfront payment ${deadlineText(event)}.` });
      break;
    case "Approval":
      add(researcher, { title: "Escrow approval recorded", workflowStatus: S.PENDING_APPROVAL,
        message: `The posting owner recorded an approval on the escrow for ${name}. Open the escrow to see the next step.` });
      add(owner, { title: "Escrow approval recorded", workflowStatus: S.PENDING_APPROVAL,
        message: `The researcher recorded an approval on the escrow for ${name}. Open the escrow to see the next step.` });
      break;
    case "MilestoneSubmitted":
      add(owner, { title: "Delivery evidence submitted", workflowStatus: S.PENDING_APPROVAL,
        message: `The researcher submitted delivery evidence for ${name}. Review it and approve or reject the final payment before the review window ends.` });
      break;
    case "SelectionInvalidated":
    case "Cancelled":
    case "Expired":
    case "Voided": {
      if (event.refundReason === "admin_cancelled") break;
      const declined = event.eventType === "SelectionInvalidated" || event.refundReason === "selection_declined";
      const lead = declined ? ENDED.SelectionInvalidated : ENDED[event.eventType];
      const status = declined ? S.DECLINED : event.eventType === "Expired" ? S.EXPIRED : S.CANCELLED;
      add(researcher, { title: declined ? "Selection rejected" : "Escrow closed", workflowStatus: status,
        message: `${lead} for your proposal ${name}. Its contributors can claim refunds of the unpaid balance. ${declined
          ? "If the posting reopens, you may submit a new proposal on it."
          : "Paid tranches stay paid."}` });
      add(owner, { title: declined ? "Selection rejected" : "Escrow closed", workflowStatus: status,
        message: `${lead} for ${name}. Its contributors can claim refunds of the unpaid balance.${declined
          ? " The posting reopens for other proposals until its original deadline." : ""}` });
      break;
    }
    default: break;
  }
  return notices;
}

export async function notifyEscrowWorkflowEvent({ db, eventId, event, now = Timestamp.now() }) {
  if (!event || event.verified !== true || typeof eventId !== "string" || !event.proposalId) return { delivered: 0 };
  if (!["SelectionLocked", "Approval", "MilestoneSubmitted", "SelectionInvalidated", "Cancelled", "Expired", "Voided"].includes(event.eventType)) {
    return { delivered: 0 };
  }
  const proposal = await db.collection("proposals").doc(event.proposalId).get();
  if (!proposal.exists) return { delivered: 0 };
  const data = proposal.data();
  let ownerId = data.postingOwnerId;
  const problemId = data.problemId || event.problemId || null;
  if (problemId) {
    const parent = await db.collection("problems").doc(problemId).get();
    if (parent.exists && parent.data().ownerId) ownerId = parent.data().ownerId;
  }
  const notices = escrowWorkflowNotices(event, { researcherId: data.researcherId, ownerId, title: data.title });
  if (!notices.length) return { delivered: 0 };
  const createdAt = Number.isSafeInteger(event.timestamp) && event.timestamp > 0 ? Timestamp.fromMillis(event.timestamp * 1000) : now;
  return db.runTransaction(async (tx) => {
    const refs = notices.map((notice) => db.collection("moderationNotifications").doc(`escrow_workflow_${eventId}_${notice.recipientId}`));
    const existing = await Promise.all(refs.map((ref) => tx.get(ref)));
    let delivered = 0;
    refs.forEach((ref, index) => {
      if (existing[index].exists) return;
      const notice = notices[index];
      tx.set(ref, { ...memberNoticeFields({ recipientId: notice.recipientId, now, createdAt, kind: "escrow",
        workflowStatus: notice.workflowStatus, contentType: "proposal", contentId: event.proposalId,
        proposalId: event.proposalId, problemId, title: notice.title, message: notice.message }),
      eventId, escrowEventType: event.eventType, transactionHash: event.transactionHash ?? null,
      registryAddress: event.registryAddress ?? null });
      delivered += 1;
    });
    return { delivered };
  });
}
