import { formatInstant } from "../lib/datetime.js";
import { proposalFundingStatus } from "../lib/matching.js";
import { StatusBadge } from "./StatusBadge.jsx";

// A proposal row's status badge, its funding note ("Funders refunded"), then the amount and date.
export function FundingMeta({ item, problemMatching }) {
  const funding = proposalFundingStatus(item, problemMatching);
  return <span className="funding-meta">
    {Object.hasOwn(item, "fundingTerms") ? <span className="draft-badge">{funding.label}</span> : <StatusBadge status={funding.status} />}
    {funding.detail && <span className="funding-note">{funding.detail}</span>}
    <span>{item.currency} {Number(item.amount).toLocaleString()} · {formatInstant(item.createdAt)}</span>
  </span>;
}
