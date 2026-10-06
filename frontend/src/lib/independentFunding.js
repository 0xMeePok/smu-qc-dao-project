import { ROLES } from "../config/roles.js";
import { independentListingWindowOpen, isIndependentProposal } from "../config/proposal.js";

/**
 * Deposit is offered to a platform member who is not the author.
 * Evaluators and administrators are excluded. A normal member holds the
 * client and funder capabilities together, so those two are the permitted set.
 */
export function canApproachIndependentListing({ proposal, user }) {
  if (!isIndependentProposal(proposal) || !proposal?.fundingTerms) return false;
  if (!independentListingWindowOpen(proposal)) return false;
  const uid = String(user?.id ?? "").toLowerCase();
  if (!uid || uid === String(proposal.researcherId ?? "").toLowerCase()) return false;
  const roles = user?.roles ?? (user?.role ? [user.role] : []);
  if (roles.includes(ROLES.EVALUATOR) || roles.includes(ROLES.ADMIN)) return false;
  return roles.includes(ROLES.OWNER) || roles.includes(ROLES.FUNDER);
}
