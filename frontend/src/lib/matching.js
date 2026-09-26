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

// Headline wording for display. The stored labels stay as they are because
// sorting and older views read them; only the short status is reworded.
const STATUS_WORDING = {
  "Rejected": "Declined",
  "Match confirmed": "Matched",
  "Funding paused": "Paused",
};

const sentenceCase = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The funding status as a short headline, an optional explanatory note and a
 * tone, so it can be shown as a status pill rather than one run-on sentence:
 * "Rejected · funders refunded" -> Declined / "Funders refunded" / neutral.
 * Tones: success (funded or matched), warning (in progress or waiting),
 * neutral (closed or refunded).
 */
export function proposalFundingStatus(proposal, problemMatching = proposal.problemMatching) {
  const full = String(proposalFundingLabel(proposal, problemMatching) ?? "").replace(/_/g, " ");
  const [head, ...rest] = full.split(" · ");
  const label = STATUS_WORDING[head] ?? sentenceCase(head);
  const detail = rest.length ? sentenceCase(rest.join(" · ")) : "";
  const tone = /^(fully funded|matched)/i.test(label) ? "success"
    : /^(open for funding|awaiting|paused)/i.test(label) ? "warning"
    : "neutral";
  return { label, detail, tone };
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
