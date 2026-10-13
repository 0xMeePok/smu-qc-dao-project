import { FundingProgress } from "./FundingProgress.jsx";
import { formatInstant } from "../lib/datetime.js";

/** Listing cards use the server's existing metric read, never an RPC per card.
 * A posting may have several separately funded proposal escrows. */
export function PostingFundingProgress({ projection }) {
  if (!projection) return null;
  if (!projection.available || projection.truncated) return <small className="field-hint">Proposal escrow progress needs verification. Open the posting to check current custody.</small>;
  if (!projection.groups?.length) return <small className="field-hint">No proposal escrow deposits yet.</small>;
  return <div className="escrow-card-progress">
    {projection.groups.slice(0, 3).map(row => <div key={row.tokenAddress}>
      <FundingProgress summary={row} compact label="Proposal escrow funding progress" />
      <small>{row.count} proposal {row.count === 1 ? "escrow" : "escrows"} · Verified as of {formatInstant(new Date(row.timestamp * 1000))}</small>
    </div>)}
    {projection.groups.length > 3 && <small>More tokens appear on the posting.</small>}
    <small>Each proposal has its own target. Funding does not select a solution.</small>
  </div>;
}
