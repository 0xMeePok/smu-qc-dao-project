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

/** A removed problem stays on Discover as its title and removal reason. */
export function toRemovedOpportunityListItem(item) {
  const openFunding = item.opportunityType === OPEN_FUNDING_TYPE;
  return {
    id: item.id,
    removed: true,
    title: item.title || "Untitled opportunity",
    reason: item.reason || "",
    reasonLabel: item.reasonLabel || item.reason || "",
    details: item.details || "",
    opportunityType: openFunding ? OPEN_FUNDING_TYPE : "business-problem",
    route: "posting",
    type: openFunding ? "Open funding" : "Business problem",
    owner: "",
    organisation: "",
    amount: "—",
    amountValue: null,
    deadline: "",
    categories: [],
    tags: [],
    proposalCount: 0,
    fundingProgressPercent: 0,
    createdAt: item.createdAt || null,
    status: "removed",
  };
}
