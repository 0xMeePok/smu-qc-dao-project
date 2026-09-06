import { PROPOSAL_CATEGORIES, PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS } from "../config/proposal.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { toDate } from "./datetime.js";

export function proposalBlockReason(posting, now = new Date()) {
  if (!posting) return "This opportunity is not available.";
  if (posting.acceptedProposalId || posting.acceptedSolutionId || posting.hasAcceptedSolution) {
    return "This opportunity already has an accepted solution.";
  }
  if (posting.moderated || posting.moderationStatus === "hidden" || posting.moderationStatus === "removed") {
    return "This opportunity is under moderation and cannot receive proposals.";
  }
  if (!["submitted", "open"].includes(posting.status)) return "This opportunity is closed to new proposals.";
  const expiry = toDate(posting.expiresAt);
  if (!expiry || expiry <= now) return "The submission deadline has passed.";
  return "";
}

export function validateProposal(form, posting) {
  const errors = {};
  const fields = [...PROPOSAL_FIELDS, ...(posting?.opportunityType === OPEN_FUNDING_TYPE ? PROBLEM_FRAMING_FIELDS : [])];
  for (const [key, label, max] of fields) {
    const value = String(form[key] ?? "").trim();
    if (!value) errors[key] = `${label} is required.`;
    else if (value.length < 2) errors[key] = "Use at least 2 characters.";
    else if (value.length > max) errors[key] = `Use ${max} characters or fewer.`;
  }
  if (!PROPOSAL_CATEGORIES.some(({ value }) => value === form.category)) errors.category = "Choose a quantum or quantum-adjacent category.";
  const amount = Number(form.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) errors.amount = "Enter a funding amount greater than 0 and no more than 1,000,000,000.";
  return errors;
}

/** Keep SDK diagnostics out of proposal screens; retain our business-rule errors. */
export function messageForProposalError(error) {
  const code = String(error?.code ?? "").split("/").pop();
  if (["permission-denied", "unauthorized"].includes(code)) return "This proposal or opportunity is not available to your account. Check that you are signed in with the correct wallet.";
  if (code === "unauthenticated") return "Your session has expired. Sign in again to continue.";
  if (["unavailable", "deadline-exceeded", "network-request-failed"].includes(code)) return "We could not reach the service. Check your connection and try again. Your form entries are still here.";
  if (code) return "We could not complete this action. Please try again.";
  return error?.message || "We could not complete this action. Please try again.";
}
