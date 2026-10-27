import { ConvertedAmount } from "./CurrencyAmount.jsx";
import { fundingAmount } from "../lib/fundingDisplay.js";
import { formatInstant } from "../lib/datetime.js";

/** Listing cards use the server's existing metric read, never an RPC per card.
 * A posting may have several separately funded proposal escrows. */
// Projections written before cancelled and refunded escrows were excluded can
// still count their deposits as raised; never show those totals.
export const ESCROW_PROGRESS_VERSION = 2;

function closedLabel(count) {
  return `${count} cancelled or refunded proposal ${count === 1 ? "escrow is" : "escrows are"} not counted.`;
}

export function PostingFundingProgress({ projection }) {
  if (!projection) return null;
  if (!projection.available || projection.truncated || projection.version !== ESCROW_PROGRESS_VERSION) return <small className="field-hint">Proposal escrow progress needs verification. Open the posting to check current custody.</small>;
  const closed = Number.isInteger(projection.closedItems) && projection.closedItems > 0 ? projection.closedItems : 0;
  if (!projection.groups?.length) return <small className="field-hint">{closed ? `No active proposal escrow funding. ${closedLabel(closed)}` : "No proposal escrow deposits yet."}</small>;
  return <div className="escrow-card-progress">
    {projection.groups.slice(0, 3).map(row => <div key={row.tokenAddress}>
      <span className="posting-funding-total"><ConvertedAmount text={fundingAmount(row.totalDeposited, row)} /> deposited</span>
      <small>Across {row.count} proposal {row.count === 1 ? "escrow" : "escrows"}</small>
      <small className="posting-funding-verified">Verified {formatInstant(new Date(row.timestamp * 1000))}</small>
    </div>)}
    {projection.groups.length > 3 && <small>More tokens appear on the posting.</small>}
    {closed > 0 && <small>{closedLabel(closed)}</small>}
    <small>Targets are per proposal.</small>
  </div>;
}
