import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { recommendationLabel } from "./comments.js";

/** QCDAO-62/63 workspace queues. Both read records that already exist. */
// A solution carries one recommendation, so "pending" already means nobody has
// recommended it yet - there is no wider pool to show.
export const QUEUE_FILTERS = [
  ["pending", "Awaiting recommendation"],
  ["submitted", "My recommendations"],
];

export const PROPOSAL_SORTS = [
  ["closing", "Closing soonest"],
  ["submitted", "Newest submission"],
];

async function call(name, payload = {}) {
  requireFirebase();
  return (await httpsCallable(functions, name)(payload)).data;
}

export const listMyProposalQueue = () => call("listMyProposalQueue");
export const listEvaluatorQueue = (payload = {}) => call("listEvaluatorQueue", payload);

/** Evaluator-feedback progress: qualifying recommendation comments, not scores. */
export function feedbackLabel(row) {
  const count = row?.qualifying ?? 0;
  if (!count) return "Awaiting evaluator recommendation";
  const named = (row.recommendations ?? []).map(recommendationLabel).filter(Boolean);
  return `${count} evaluator recommendation${count === 1 ? "" : "s"}${named.length ? `: ${named.join(", ")}` : ""}`;
}

export { ownerReviewTrackerLabel } from "./ownerReviews.js";

export function commentCountLabel(row) {
  const count = row?.comments ?? 0;
  return count === 1 ? "1 comment" : `${count} comments`;
}

const time = (value) => (value ? Date.parse(value) : NaN);

export function sortProposalRows(rows, sort = "closing") {
  return [...(rows ?? [])].sort((a, b) => {
    if (sort === "submitted") return (time(b.createdAt ?? b.submittedAt) || 0) - (time(a.createdAt ?? a.submittedAt) || 0);
    // Closing soonest, with postings that carry no deadline last.
    const left = time(a.posting?.expiresAt), right = time(b.posting?.expiresAt);
    if (Number.isNaN(left) && Number.isNaN(right)) return 0;
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return left - right;
  });
}

export function filterProposalRows(rows, status = "all") {
  return status === "all" ? [...(rows ?? [])] : (rows ?? []).filter((row) => row.status === status);
}

export function statusOptions(rows) {
  return [...new Set((rows ?? []).map((row) => row.status).filter(Boolean))].sort();
}

export function queueError(error) {
  const code = String(error?.code || "").split("/").pop();
  if (code === "unauthenticated") return "Sign in again to continue.";
  if (code === "permission-denied") return error.message || "This queue is not available for your account.";
  return "Could not load the queue. Please try again.";
}
