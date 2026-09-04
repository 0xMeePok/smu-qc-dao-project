import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { formatInstantDate } from "./datetime.js";

export function opportunityTypeLabel(opportunity) {
  return opportunity.opportunityType === OPEN_FUNDING_TYPE
    ? "Open funding"
    : "Business problem";
}

export function toOpportunityListItem(opportunity) {
  return {
    ...opportunity,
    route: "posting",
    owner: opportunity.organisation,
    type: opportunityTypeLabel(opportunity),
    amount: `${opportunity.currency} ${Number(opportunity.amount).toLocaleString()}`,
    deadline: formatInstantDate(opportunity.expiresAt),
  };
}
