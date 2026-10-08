import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { WORKFLOW_STATUS, proposalWorkflowStatus, workflowStatusLabel } from "../config/workflowStatus.js";
import { isIndependentProposal } from "../config/proposal.js";
import { independentFundingStatus } from "./independentEscrow.js";

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

export function mergeMatchingState(previous, current) {
  if (!current) return previous;
  if (!previous) return current;
  return { ...previous, ...current };
}

/**
 * A proposal row's status from the shared QCDAO-91 mapping, plus a funding note
 * that explains it ("Fully funded · ready for owner selection").
 */
export function proposalFundingStatus(proposal, problemMatching = proposal.problemMatching) {
  if (isIndependentProposal(proposal)) return independentFundingStatus(proposal.independentFunding);
  if (Object.hasOwn(proposal, "fundingTerms")) return { label: "On-chain escrow",
    detail: "Open the proposal for wallet funding and delivery status.", tone: "neutral" };
  const status = proposalWorkflowStatus(proposal, problemMatching);
  const own = proposal.matching?.status;
  const parent = problemMatching?.status;
  const target = Number(proposal.amount);
  const funded = Number(proposal.fundedAmount ?? proposal.matching?.fundedAmount ?? 0);
  let detail = "";
  if ([WORKFLOW_STATUS.INVALIDATED, WORKFLOW_STATUS.DECLINED, WORKFLOW_STATUS.REFUNDED].includes(status)) {
    detail = proposal.status === "withdrawn" ? "" : "Funders refunded";
  } else if (own === "awaiting_confirmation") detail = "Waiting for the creator to accept";
  else if (status === WORKFLOW_STATUS.ACCEPTED) detail = "Funding locked";
  else if (status === WORKFLOW_STATUS.SUBMITTED && parent === "awaiting_confirmation" && proposal.id !== problemMatching?.proposalId) {
    detail = "Funding paused while another proposal is pending approval";
  } else if (status === WORKFLOW_STATUS.SUBMITTED) {
    detail = target > 0 && funded >= target ? "Fully funded · ready for owner selection" : "Open for funding";
  }
  return { status, label: workflowStatusLabel(status), detail };
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
