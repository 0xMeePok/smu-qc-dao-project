import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { categoryLabel } from "../config/postingCategories.js";
import { formatInstantDate } from "./datetime.js";

export function opportunityTypeLabel(opportunity) {
  return opportunity.opportunityType === OPEN_FUNDING_TYPE
    ? "Open funding"
    : "Business problem";
}

export function toOpportunityListItem(opportunity) {
  const amountValue = Number(opportunity.amount);
  const progress = Number(opportunity.fundingProgressPercent ?? 0);
  const proposalCount = Number(opportunity.proposalCount ?? 0);
  return {
    ...opportunity,
    route: "posting",
    owner: opportunity.organisation,
    type: opportunityTypeLabel(opportunity),
    amountValue: Number.isFinite(amountValue) ? amountValue : 0,
    amount: `${opportunity.currency} ${Number.isFinite(amountValue) ? amountValue.toLocaleString() : "—"}`,
    deadline: formatInstantDate(opportunity.expiresAt),
    categoryLabels: (opportunity.categories ?? []).map(categoryLabel),
    proposalCount: Number.isFinite(proposalCount) && proposalCount >= 0 ? proposalCount : 0,
    fundingProgressPercent: Number.isFinite(progress)
      ? Math.max(0, Math.min(100, progress))
      : 0,
  };
}
