import { fundingAmount, fundingPercentage, fundingUnits, hasConfirmedFunding } from "../lib/fundingDisplay.js";
import { shortenAddress } from "../lib/chain.js";
import { INDEPENDENT_FUNDING_STATE, MAIN_ESCROW_STATE, MAIN_ESCROW_STATES, INDEPENDENT_ESCROW_STATES } from "../config/workflowStatus.js";
import { fundingExplorer, validFundingAddress } from "../lib/fundingDisplay.js";

// Main and independent escrow states in which deposits are being returned.
const CLOSED_ESCROW_STATES = new Set([MAIN_ESCROW_STATE.REFUNDED, MAIN_ESCROW_STATE.CANCELLED, MAIN_ESCROW_STATE.EXPIRED,
  MAIN_ESCROW_STATE.VOIDED, INDEPENDENT_FUNDING_STATE.DECLINED]);

/** A rejected, cancelled, expired or refunding escrow's deposits are not raised funding. */
export function escrowFundingClosed(summary = {}) {
  const states = summary.workflow === "independent-crowdfunding" ? INDEPENDENT_ESCROW_STATES : MAIN_ESCROW_STATES;
  const state = typeof summary.state === "number" ? states[summary.state] : summary.state;
  return CLOSED_ESCROW_STATES.has(state) || summary.refundsEnabled === true || summary.invalidated === true || summary.workflowInvalidated === true;
}

export function FundingProgress({ summary = {}, compact = false, stale = false, label = "Confirmed funding progress" }) {
  const percent = fundingPercentage(summary.totalDeposited, summary.fundingTarget);
  const available = !stale && hasConfirmedFunding(summary) && percent !== null
    && fundingAmount(summary.totalDeposited, summary) !== "—" && fundingAmount(summary.fundingTarget, summary) !== "—";
  if (!available) return <p className="field-hint" data-funding-status="unverified">Funding progress needs verification. Refresh to check the confirmed raised amount and target.</p>;
  if (escrowFundingClosed(summary)) {
    const settled = fundingUnits(summary.outstandingBalance) === 0n;
    return <div className="rollup-meter" data-funding-status="closed">
      <small>Escrow closed · {fundingAmount(summary.totalDeposited, summary)} was deposited toward {fundingAmount(summary.fundingTarget, summary)}. {settled ? "No unpaid balance remains in escrow." : "It no longer counts as raised; contributors can claim refunds of any unpaid balance."}</small>
    </div>;
  }
  const deposited = fundingUnits(summary.totalDeposited), target = fundingUnits(summary.fundingTarget);
  const reached = deposited >= target;
  const custodyShortfall = reached && (summary.state === "Open" || summary.state === 0) && summary.fundingRequirementMet === false;
  return <div className="rollup-meter" data-funding-status={reached ? "funded" : "pending"}>
    <progress aria-label={label} aria-valuetext={`${percent.text} funded`} value={percent.value} max={100} />
    <small>{fundingAmount(deposited, summary)} raised of {fundingAmount(target, summary)} required · {percent.text}</small>
    {reached && <strong className={custodyShortfall ? "queue-note-gate" : "queue-note-ready"}>{custodyShortfall ? "Target reached; custody requirement not met" : "Fully funded"}</strong>}
    {!compact && <p className="field-hint">Recorded contributions determine this progress. Contract custody and workflow checks still control selection and withdrawals.</p>}
  </div>;
}

export function ContributorWallet({ address }) {
  if (!validFundingAddress(address)) return <span>Wallet unavailable</span>;
  return <a href={fundingExplorer("address", address)} title={address} aria-label={`Wallet ${address}`} target="_blank" rel="noreferrer">{shortenAddress(address)}</a>;
}

export function FundingContributors({ summary = {}, stale = false }) {
  const contributors = summary.contributors;
  if (stale || !hasConfirmedFunding(summary) || contributors?.available !== true || contributors?.complete !== true) return <p className="field-hint">Confirmed contributor details are unavailable. Refresh or open the funding audit trail to verify contributions.</p>;
  if (!contributors.items?.length) return <p className="field-hint">No confirmed contributors yet.</p>;
  return <section aria-label="Confirmed contributors">
    <h4>Contributors</h4>
    <p className="field-hint">Shares use each wallet&apos;s recorded contribution divided by total recorded contributions. Public profile names identify contributors when available.</p>
    <div className="audit-table-scroll" role="region" aria-label="Contributor amounts and shares" tabIndex={0}><table className="audit-nav-table">
      <thead><tr><th scope="col">Funder</th><th scope="col">Contributed</th><th scope="col">Share</th></tr></thead>
      <tbody>{contributors.items.map(item => <tr key={item.walletAddress}>
        <td>{typeof item.displayName === "string" && item.displayName.trim() && <><strong>{item.displayName.trim()}</strong><br /></>}<ContributorWallet address={item.walletAddress} /></td>
        <td>{fundingAmount(item.committed, summary)}</td>
        <td>{fundingPercentage(item.committed, summary.totalDeposited)?.text ?? "—"}</td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}
