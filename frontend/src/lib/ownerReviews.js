import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";

export const OWNER_REVIEW_OUTCOMES = [
  ["feedback", "Record feedback"],
  ["revision_requested", "Request revisions"],
  ["not_progressing", "Not progressing"],
];

const LABELS = Object.fromEntries(OWNER_REVIEW_OUTCOMES);

async function call(name, payload = {}) {
  requireFirebase();
  return (await httpsCallable(functions, name)(payload)).data;
}

export const recordOwnerReview = (payload) => call("recordOwnerReview", payload);
export const listOwnerReviews = (proposalId) => call("listOwnerReviews", { proposalId });

export function ownerReviewLabel(outcome) {
  return LABELS[outcome] || "";
}

/** Tracker line for the developer. Separate from evaluator recommendation progress. */
export function ownerReviewTrackerLabel(review) {
  if (!review?.outcome) return "";
  if (review.outcome === "revision_requested") {
    return review.correctionPathOpen
      ? "Owner requested revisions · you can edit and resubmit"
      : "Owner requested revisions";
  }
  if (review.outcome === "not_progressing") return "Owner recorded: not progressing";
  return "Owner recorded feedback";
}

export function ownerReviewError(error) {
  const code = String(error?.code || "").split("/").pop();
  if (code === "unauthenticated") return "Sign in again to continue.";
  if (["invalid-argument", "permission-denied", "failed-precondition", "not-found", "already-exists"].includes(code)) {
    return error.message || "This review could not be recorded.";
  }
  return "Could not record the review. Please try again.";
}
