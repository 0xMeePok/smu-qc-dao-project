import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { ROLES } from "../config/roles.js";
import { OPPORTUNITY_STATUSES } from "../config/workflowStatus.js";
import { proposalBlockReason } from "./proposalValidation.js";

const FUND_CLOSED_STATUSES = new Set([
  OPPORTUNITY_STATUSES.DRAFT,
  OPPORTUNITY_STATUSES.CANCELLED,
  OPPORTUNITY_STATUSES.COMPLETED,
]);

const EVALUABLE_STATUSES = new Set([
  OPPORTUNITY_STATUSES.IN_REVIEW,
  OPPORTUNITY_STATUSES.MATCHED,
  OPPORTUNITY_STATUSES.FUNDED,
]);

function rolesOf(user) {
  if (Array.isArray(user?.roles) && user.roles.length) return user.roles;
  return user?.role ? [user.role] : [];
}

function sameWallet(left, right) {
  const a = String(left ?? "").toLowerCase();
  const b = String(right ?? "").toLowerCase();
  return Boolean(a) && a === b;
}

function postingStatus(posting) {
  return String(posting?.status ?? "").trim().toLowerCase();
}

/**
 * Role- and workflow-gated actions for a posting detail page.
 * Destinations are existing routes; Comment is omitted (no comments backend).
 */
export function postingActions(posting, user, { isAuthenticated = Boolean(user) } = {}) {
  if (!posting) return [];

  const roles = rolesOf(user);
  const owns = sameWallet(user?.id, posting.ownerId);
  const status = postingStatus(posting);
  const blocked = proposalBlockReason(posting);
  const actions = [];

  if (!blocked && roles.includes(ROLES.RESEARCHER)) {
    actions.push({
      id: "submit",
      label: "Submit a proposal",
      route: `submit-proposal/${posting.id}`,
      kind: "primary",
    });
  } else if (!blocked && !isAuthenticated) {
    actions.push({
      id: "submit-signin",
      label: "Sign in to submit a proposal",
      route: `login?redirect=${encodeURIComponent(`submit-proposal/${posting.id}`)}`,
      kind: "primary",
    });
  }

  if (
    isAuthenticated
    && roles.includes(ROLES.FUNDER)
    && !owns
    && !FUND_CLOSED_STATUSES.has(status)
  ) {
    actions.push({
      id: "fund",
      label: "Fund this posting",
      route: "funding",
      kind: "secondary",
    });
  }

  if (isAuthenticated && roles.includes(ROLES.EVALUATOR) && EVALUABLE_STATUSES.has(status)) {
    actions.push({
      id: "evaluate",
      label: "Evaluate",
      route: "evaluations",
      kind: "secondary",
    });
  }

  if (roles.includes(ROLES.ADMIN)) {
    actions.push({
      id: "moderate",
      label: "Moderate",
      route: "admin",
      kind: "secondary",
    });
  }

  if (owns && status === OPPORTUNITY_STATUSES.DRAFT) {
    actions.push({
      id: "edit",
      label: "Edit",
      route: posting.opportunityType === OPEN_FUNDING_TYPE
        ? `create-funding/${posting.id}`
        : `create/${posting.id}`,
      kind: "secondary",
    });
  }

  return actions;
}
