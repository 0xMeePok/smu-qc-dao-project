import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { WORKFLOW_STATUS, INDEPENDENT_FUNDING_STATE as I } from "../config/workflowStatus.js";

/** QCDAO-62/63 workspace queues. Both read records that already exist. */
// Each evaluator files their own recommendation, so "pending" means not yet by me.
export const QUEUE_FILTERS = [
  ["pending", "Awaiting recommendation"],
  ["submitted", "My recommendations"],
];

export const PROPOSAL_SORTS = [
  ["closing", "Earliest deadline"],
  ["submitted", "Newest submission"],
];

async function call(name, payload = {}) {
  requireFirebase();
  return (await httpsCallable(functions, name)(payload)).data;
}

export const listMyProposalQueue = () => call("listMyProposalQueue");
export const listEvaluatorQueue = (payload = {}) => call("listEvaluatorQueue", payload);
export const listActionItems = () => call("listActionItems");
export const ACTION_ITEMS_KEY = ["actionItems"];

/** QCDAO-92 owner roll-up: postings, solution counts, funding and feedback. */
export const listOwnerDashboard = () => call("listOwnerDashboard");
export const OWNER_DASHBOARD_KEY = ["ownerDashboard"];

export { ownerReviewStatus } from "./ownerReviews.js";

export function commentCountLabel(row) {
  const count = row?.comments ?? 0;
  return count === 1 ? "1 comment" : `${count} comments`;
}

const time = (value) => (value ? Date.parse(value) : NaN);

export function proposalQueueDeadline(row) {
  if (isIndependentQueueRow(row) && row?.independentFunding) {
    const summary = row.independentFunding.summary ?? row.independentFunding;
    const seconds = summary.state === I.ACCEPTED ? summary.completionDeadline : summary.expiresAt;
    return Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toISOString() : row.expiresAt;
  }
  if (row?.grantUnavailable || row?.escrowUnavailable) return null;
  if (["pending", "expired"].includes(row?.grant?.status)) {
    if (row.grant.deadlineAt) return row.grant.deadlineAt;
    const seconds = Number(row.grant.acceptanceDeadline);
    const deadline = new Date(seconds * 1000);
    return seconds > 0 && Number.isFinite(deadline.getTime()) ? deadline.toISOString() : null;
  }
  if (row?.escrow) return row.escrow.deadlineAt ?? null;
  if (["accepted", "voided"].includes(row?.grant?.status)) return null;
  return row?.expiresAt ?? row?.posting?.expiresAt;
}

export function proposalQueueWorkflowStatus(row) {
  if (isIndependentQueueRow(row) && row?.independentFunding) {
    const states = { Open: WORKFLOW_STATUS.SUBMITTED, Accepted: WORKFLOW_STATUS.ACCEPTED, Released: WORKFLOW_STATUS.COMPLETED,
      Declined: WORKFLOW_STATUS.DECLINED, Expired: WORKFLOW_STATUS.EXPIRED, Cancelled: WORKFLOW_STATUS.CANCELLED,
      Refunded: WORKFLOW_STATUS.REFUNDED };
    return states[(row.independentFunding.summary ?? row.independentFunding).state] ?? row.workflowStatus ?? row.status;
  }
  if (row?.grantUnavailable || row?.escrowUnavailable) return undefined;
  if (row?.grant?.status === "accepted") return row?.escrow?.workflowStatus ?? WORKFLOW_STATUS.ACCEPTED;
  const grantStatuses = { pending: WORKFLOW_STATUS.SELECTED,
    expired: WORKFLOW_STATUS.EXPIRED, voided: WORKFLOW_STATUS.INVALIDATED };
  return grantStatuses[row?.grant?.status] ?? row?.escrow?.workflowStatus ?? row?.workflowStatus ?? row?.status;
}

export function sortProposalRows(rows, sort = "closing") {
  return [...(rows ?? [])].sort((a, b) => {
    if (sort === "submitted") return (time(b.createdAt ?? b.submittedAt) || 0) - (time(a.createdAt ?? a.submittedAt) || 0);
    // Earliest deadline first, with postings that carry no deadline last.
    const left = time(proposalQueueDeadline(a)), right = time(proposalQueueDeadline(b));
    if (Number.isNaN(left) && Number.isNaN(right)) return 0;
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return left - right;
  });
}

// Rows filter on the shared QCDAO-91 status, not the stored field.
const statusOf = proposalQueueWorkflowStatus;

export function filterProposalRows(rows, status = "all") {
  return status === "all" ? [...(rows ?? [])] : (rows ?? []).filter((row) => statusOf(row) === status);
}

export function statusOptions(rows) {
  return [...new Set((rows ?? []).map(statusOf).filter(Boolean))].sort();
}

export function isIndependentQueueRow(row) {
  return row?.proposalKind === "independent" || !row?.problemId;
}

export function queueError(error) {
  const code = String(error?.code || "").split("/").pop();
  if (code === "unauthenticated") return "Sign in again to continue.";
  if (code === "permission-denied") return error.message || "This queue is not available for your account.";
  return "Could not load the queue. Please try again.";
}
