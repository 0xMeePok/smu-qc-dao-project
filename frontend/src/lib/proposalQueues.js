import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";

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

export { ownerReviewStatus } from "./ownerReviews.js";

export function commentCountLabel(row) {
  const count = row?.comments ?? 0;
  return count === 1 ? "1 comment" : `${count} comments`;
}

const time = (value) => (value ? Date.parse(value) : NaN);

export function sortProposalRows(rows, sort = "closing") {
  return [...(rows ?? [])].sort((a, b) => {
    if (sort === "submitted") return (time(b.createdAt ?? b.submittedAt) || 0) - (time(a.createdAt ?? a.submittedAt) || 0);
    // Earliest deadline first, with postings that carry no deadline last.
    const left = time(a.posting?.expiresAt), right = time(b.posting?.expiresAt);
    if (Number.isNaN(left) && Number.isNaN(right)) return 0;
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return left - right;
  });
}

// Rows filter on the shared QCDAO-91 status, not the stored field.
const statusOf = (row) => row?.workflowStatus || row?.status;

export function filterProposalRows(rows, status = "all") {
  return status === "all" ? [...(rows ?? [])] : (rows ?? []).filter((row) => statusOf(row) === status);
}

export function statusOptions(rows) {
  return [...new Set((rows ?? []).map(statusOf).filter(Boolean))].sort();
}

export function queueError(error) {
  const code = String(error?.code || "").split("/").pop();
  if (code === "unauthenticated") return "Sign in again to continue.";
  if (code === "permission-denied") return error.message || "This queue is not available for your account.";
  return "Could not load the queue. Please try again.";
}
