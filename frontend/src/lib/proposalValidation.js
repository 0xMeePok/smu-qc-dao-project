import {
  INDEPENDENT_PROPOSAL_FIELDS,
  PROPOSAL_CATEGORIES,
  PROPOSAL_FIELDS,
  PROBLEM_FRAMING_FIELDS,
  PROPOSAL_MATURITY_VALUES,
} from "../config/proposal.js";
import { CURRENCIES } from "../config/postingCategories.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { toDate } from "./datetime.js";
import { isModuleLoadError, MODULE_LOAD_ERROR_MESSAGE } from "./errors.js";
import { AUDIT_REGISTRY_CONFIG } from "../config/auditRegistry.js";
import { isEscrowRegistry } from "../../../firebase/functions/escrowAudit.js";
import { proposalFundingTerms } from "../../../firebase/functions/escrowProposalTerms.js";
import { validateExpiry } from "./validation.js";

export function proposalBlockReason(posting, now = new Date()) {
  if (!posting) return "This opportunity is not available.";
  if (posting.matching?.status === "awaiting_confirmation") return "A selected proposal is awaiting creator acceptance. New proposals are paused during the acceptance window.";
  if (posting.matching?.status === "invalidated") return "This opportunity was invalidated and is closed to new proposals.";
  if (posting.matching?.status === "confirmed") return "This opportunity already has a confirmed match.";
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
  if (isEscrowRegistry(AUDIT_REGISTRY_CONFIG) && !errors.amount) {
    try { proposalFundingTerms({ form, currency: posting?.currency, config: AUDIT_REGISTRY_CONFIG }); }
    catch (error) { errors.fundingPlan = error.message; }
  }
  return errors;
}

export function validateIndependentProposal(form, { requireFundingPlan = true } = {}) {
  const errors = {};
  for (const [key, label, max] of INDEPENDENT_PROPOSAL_FIELDS) {
    const value = String(form[key] ?? "").trim();
    if (!value) errors[key] = `${label} is required.`;
    else if (value.length < 2) errors[key] = "Use at least 2 characters.";
    else if (value.length > max) errors[key] = `Use ${max} characters or fewer.`;
  }
  if (!PROPOSAL_CATEGORIES.some(({ value }) => value === form.category)) {
    errors.category = "Choose a quantum or quantum-adjacent category.";
  }
  if (!PROPOSAL_MATURITY_VALUES.includes(form.maturity)) {
    errors.maturity = "Choose a maturity or readiness level.";
  }
  const amount = Number(form.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
    errors.amount = "Enter a funding amount greater than 0 and no more than 1,000,000,000.";
  }
  if (!CURRENCIES.includes(form.currency)) errors.currency = "Choose a funding currency.";
  if (validateExpiry(form.expiryDays)) errors.expiryDays = validateExpiry(form.expiryDays);
  // Published listings freeze the escrow plan. Content edits must not rebuild
  // those terms — the correction write does not touch fundingTerms, and stored
  // maps are not always canonical enough to round-trip through normalizeFundingTerms.
  if (requireFundingPlan && isEscrowRegistry(AUDIT_REGISTRY_CONFIG) && !errors.amount && !errors.currency) {
    try {
      proposalFundingTerms({ form: { ...form, milestones: form.milestones ?? "" }, currency: form.currency, config: AUDIT_REGISTRY_CONFIG });
    } catch (error) { errors.fundingPlan = error.message; }
  }
  return errors;
}

/** Keep SDK diagnostics out of proposal screens; retain our business-rule errors. */
export function messageForProposalError(error) {
  if (isModuleLoadError(error)) return MODULE_LOAD_ERROR_MESSAGE;
  const code = String(error?.code ?? "").split("/").pop();
  if (["permission-denied", "unauthorized"].includes(code)) return "This proposal or opportunity is not available to your account. Check that you are signed in with the correct wallet.";
  if (code === "unauthenticated") return "Your session has expired. Sign in again to continue.";
  if (["unavailable", "deadline-exceeded", "network-request-failed"].includes(code)) return "We could not reach the service. Check your connection and try again. Your form entries are still here.";
  if (code) return "We could not complete this action. Please try again.";
  return error?.message || "We could not complete this action. Please try again.";
}
