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
  awaiting_confirmation: "Awaiting creator confirmation",
  confirmed: "Match confirmed · funding locked",
  voided: "Voided · funders refunded",
  cancelled: "Cancelled · funders refunded",
  declined: "Declined · funders refunded",
  pledged: "Pledged",
  locked: "Locked",
  refunded: "Refunded",
};

export function matchingStatusLabel(status) {
  return MATCHING_LABELS[status] || MATCHING_LABELS.funding;
}

export function mergeMatchingState(previous, current) {
  if (!current) return previous;
  if (!previous) return current;
  return { ...previous, ...current };
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
  return proposal?.matching?.evaluationComplete === true
    || Number(proposal?.matching?.fundedAmount ?? 0) > 0
    || ["awaiting_confirmation", "confirmed", "voided", "cancelled", "declined"].includes(proposal?.matching?.status);
}

export function problemMatchingLocked(posting) {
  return Number(posting?.matching?.totalFundedMinor ?? 0) > 0
    || ["awaiting_confirmation", "confirmed"].includes(posting?.matching?.status);
}
