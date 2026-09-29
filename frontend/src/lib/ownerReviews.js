import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { WORKFLOW_STATUS, ownerReviewWorkflowStatus, workflowStatusLabel } from "../config/workflowStatus.js";

export const OWNER_REVIEW_OUTCOMES = [
  ["feedback", "Record feedback"],
  ["revision_requested", "Request revisions"],
  ["not_progressing", workflowStatusLabel(WORKFLOW_STATUS.NOT_PROGRESSING)],
];

async function call(name, payload = {}) {
  requireFirebase();
  return (await httpsCallable(functions, name)(payload)).data;
}

export const recordOwnerReview = (payload) => call("recordOwnerReview", payload);
export const listOwnerReviews = (proposalId) => call("listOwnerReviews", { proposalId });

/** The owner's latest review as a shared status, plus the developer's next step. */
export function ownerReviewStatus(review) {
  const status = ownerReviewWorkflowStatus(review?.outcome);
  if (!status) return null;
  return { status, note: review.outcome === "revision_requested" && review.correctionPathOpen ? "You can edit and resubmit" : "" };
}

export function ownerReviewError(error) {
  const code = String(error?.code || "").split("/").pop();
  if (code === "unauthenticated") return "Sign in again to continue.";
  if (["invalid-argument", "permission-denied", "failed-precondition", "not-found", "already-exists"].includes(code)) {
    return error.message || "This review could not be recorded.";
  }
  return "Could not record the review. Please try again.";
}
