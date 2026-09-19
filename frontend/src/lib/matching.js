import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";

async function call(name, payload = {}) {
  requireFirebase();
  const { data } = await httpsCallable(functions, name)(payload);
  return data;
}

export const getMockMatching = (problemId, { proposalId, cursor } = {}) => call("getMockMatching", {
  problemId, ...(proposalId ? { proposalId } : {}), ...(cursor ? { cursor } : {}),
});
export const getMockFundingPortfolio = () => call("getMockFundingPortfolio");
export const fundMockProposal = (payload) => call("fundMockProposal", payload);
export const selectMockProposal = (payload) => call("selectMockProposal", payload);
export const confirmMockProposal = (payload) => call("confirmMockProposal", payload);
export const declineMockProposal = (payload) => call("declineMockProposal", payload);
export const completeMockEvaluation = (payload) => call("completeMockEvaluation", payload);
export const forceExpireMockMatch = (payload) => call("forceExpireMockMatch", payload);

export const MATCHING_LABELS = {
  funding: "Open for funding",
  awaiting_confirmation: "Awaiting creator acceptance",
  confirmed: "Match confirmed · funding locked",
  voided: "Voided · funders refunded",
  invalidated: "Invalidated · funders refunded",
  cancelled: "Cancelled · funders refunded",
  declined: "Rejected · funders refunded",
  pledged: "Pledged",
  locked: "Locked",
  refunded: "Refunded",
};

export function mergeMatchingState(previous, current) {
  if (!current) return previous;
  if (!previous) return current;
  return { ...previous, ...current };
}

export function proposalFundingLabel(proposal, problemMatching = proposal.problemMatching) {
  const status = proposal.matching?.status;
  if (status && status !== "funding") return MATCHING_LABELS[status] || status;
  if (proposal.status && !["submitted", "under_review"].includes(proposal.status)) return proposal.status;
  if (problemMatching?.status === "invalidated") return MATCHING_LABELS.invalidated;
  if (problemMatching?.status === "confirmed") return "Not selected · funders refunded";
  if (problemMatching?.status === "awaiting_confirmation") {
    return proposal.id === problemMatching.proposalId
      ? MATCHING_LABELS.awaiting_confirmation
      : "Funding paused · another proposal selected";
  }
  const target = Number(proposal.amount);
  const funded = Number(proposal.fundedAmount ?? proposal.matching?.fundedAmount ?? 0);
  return target > 0 && funded >= target
    ? "Fully funded · awaiting owner selection"
    : "Open for funding";
}

export function matchingError(error) {
  const code = String(error?.code ?? "").split("/").pop();
  if (code === "unauthenticated") return "Sign in again to continue.";
  if (["invalid-argument", "failed-precondition", "already-exists", "permission-denied", "resource-exhausted"].includes(code)) {
    return error.message || "This action is no longer available. Refresh the funding status.";
  }
  return "Funding status could not be updated. Check your connection and retry.";
}

export function proposalMatchingLocked(proposal) {
  return ["awaiting_confirmation", "confirmed", "invalidated"].includes(proposal?.problemMatching?.status)
    || proposal?.matching?.evaluationComplete === true
    || Number(proposal?.matching?.fundedAmount ?? 0) > 0
    || ["awaiting_confirmation", "confirmed", "voided", "cancelled", "declined", "invalidated"].includes(proposal?.matching?.status);
}

export function problemMatchingLocked(posting) {
  return Number(posting?.matching?.totalFundedMinor ?? 0) > 0
    || ["awaiting_confirmation", "confirmed", "invalidated"].includes(posting?.matching?.status);
}
