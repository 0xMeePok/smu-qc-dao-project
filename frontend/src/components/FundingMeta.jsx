import { formatInstant } from "../lib/datetime.js";
import { proposalFundingStatus } from "../lib/matching.js";

// A proposal row's funding state as a pill, its consequence ("Funders refunded")
// as a quiet note, then the amount and date.
export function FundingMeta({ item, problemMatching }) {
  const funding = proposalFundingStatus(item, problemMatching);
  return <>
    <span className={`funding-pill tone-${funding.tone}`}>{funding.label}</span>
    {funding.detail && <span className="funding-note">{funding.detail}</span>}
    <span>{item.currency} {Number(item.amount).toLocaleString()} · {formatInstant(item.createdAt)}</span>
  </>;
}
