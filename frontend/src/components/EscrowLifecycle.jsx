import { ConvertedAmount } from "./CurrencyAmount.jsx";
import { escrowLifecycle, confirmedFundingEvents, fundingAmount, fundingExplorer, fundingUnits, validFundingTransaction } from "../lib/fundingDisplay.js";
import { formatInstant } from "../lib/datetime.js";
import { MAIN_ESCROW_STATE, ESCROW_ADMIN_CANCELLATION_LABEL, ESCROW_REFUND_REASON_LABELS } from "../config/workflowStatus.js";

const EVENT_LABELS = {
  EscrowCreated: "Escrow created", Deposit: "Contribution deposited", SelectionLocked: "Selection confirmed",
  Approval: "Approval confirmed", SelectionInvalidated: "Selection rejected · Refunds opened", Cancelled: "Escrow cancelled",
  Expired: "Escrow expired", MilestoneSubmitted: "Delivery evidence submitted", TrancheReleased: "Payment released",
  Voided: "Escrow invalidated", RefundClaimed: "Refund claimed", FunderVote: "Funder vote confirmed",
};
const EVENT_STATES = { EscrowCreated: MAIN_ESCROW_STATE.OPEN, SelectionLocked: MAIN_ESCROW_STATE.LOCKED,
  Cancelled: MAIN_ESCROW_STATE.CANCELLED, Expired: MAIN_ESCROW_STATE.EXPIRED, Voided: MAIN_ESCROW_STATE.VOIDED };

function confirmedEventLabel(event, summary) {
  const type = event.eventType ?? event.type;
  const label = type === "Voided" && event.refundReason === "admin_cancelled" ? ESCROW_ADMIN_CANCELLATION_LABEL
    : EVENT_LABELS[type] ?? String(type ?? "Confirmed funding event").replace(/([a-z])([A-Z])/g, "$1 $2");
  const state = event.stateAfter ?? EVENT_STATES[type];
  const lifecycle = state == null ? null : escrowLifecycle({ verified: true, state, workflow: summary.workflow, refundReason: event.refundReason });
  return lifecycle && lifecycle.key !== "unverified" ? `${label} · ${lifecycle.label}` : label;
}

/** The open-state meaning must not say "funding is open" once the target is held. */
function lifecycleMeaning(lifecycle, summary) {
  if (lifecycle.key !== "pending" || summary.workflow === "independent-crowdfunding") return lifecycle.meaning;
  const target = fundingUnits(summary.fundingTarget ?? summary.target), deposited = fundingUnits(summary.totalDeposited);
  if (summary.isGrant && deposited === 0n) return "Waiting for grant funding. The grant moves into this escrow when the researcher accepts the selected offer.";
  if (target !== null && target > 0n && deposited !== null && deposited >= target) {
    return "Fully funded. Contributions stay in escrow until the problem owner selects this proposal and both owners approve the upfront payment, or an eligible refund opens.";
  }
  return lifecycle.meaning;
}

export function EscrowLifecycleBadge({ summary = {}, compact = false, stale = false, showLabel = true }) {
  const lifecycle = escrowLifecycle(summary, { stale });
  const reason = ["refunded", "cancelled", "expired", "invalidated"].includes(lifecycle.key)
    ? ESCROW_REFUND_REASON_LABELS[summary.refundReason ?? summary.lifecycle?.refundReason] : null;
  return <div data-escrow-lifecycle={lifecycle.key}>
    {showLabel && <span className={`status-badge status-${lifecycle.key}`} aria-label={`Escrow state: ${lifecycle.label}`}>{lifecycle.label}</span>}
    {!compact && <p className="field-hint">{lifecycleMeaning(lifecycle, summary)}</p>}
    {reason && <p className="field-hint">Refund reason: {reason}</p>}
  </div>;
}

export function EscrowMoneySummary({ summary = {}, compact = false, stale = false }) {
  const lifecycle = escrowLifecycle(summary, { stale });
  if (lifecycle.key === "unverified") return <p className="field-hint">Escrow balances need verification. Unavailable balances are not zero.</p>;
  return <dl className="settings-group" aria-label="Confirmed escrow balances">
    <div className="settings-row"><dt>Held in escrow</dt><dd><ConvertedAmount text={fundingAmount(summary.outstandingBalance, summary)} /></dd></div>
    {!compact && <>
      <div className="settings-row"><dt>Released before fees</dt><dd><ConvertedAmount text={fundingAmount(summary.totalReleased, summary)} /></dd></div>
      <div className="settings-row"><dt>Refunded to contributors</dt><dd><ConvertedAmount text={fundingAmount(summary.totalRefunded, summary)} /></dd></div>
    </>}
  </dl>;
}

export function EscrowLifecycleTimeline({ summary = {}, events = [], stale = false, onAuditReceipt }) {
  const confirmed = confirmedFundingEvents(events);
  return <section className="detail-section" aria-label="Confirmed escrow lifecycle">
    <h4>State history</h4>
    <p className="field-hint">Only confirmed contract events appear here. Wallet signatures and pending transactions do not change the escrow state.</p>
    {stale && <p className="field-hint">Previously confirmed history is shown. Refresh to check for later state changes.</p>}
    {confirmed.length ? <ol className="audit-timeline">{confirmed.map((event, index) => <li key={event.id ?? `${event.transactionHash}:${event.logIndex ?? index}`}>
      <strong>{confirmedEventLabel(event, summary)}</strong>{" · "}
      <time dateTime={new Date(event.timestamp * 1000).toISOString()}>{formatInstant(new Date(event.timestamp * 1000))}</time>
      {event.amountBaseUnits != null && <small className="table-row-meta"><ConvertedAmount text={fundingAmount(event.amountBaseUnits, { ...summary, tokenDecimals: event.tokenDecimals ?? summary.tokenDecimals ?? summary.decimals, tokenSymbol: event.tokenSymbol ?? summary.tokenSymbol ?? summary.symbol })} /></small>}
      <div className="table-row-actions">
        <a href={fundingExplorer("tx", event.transactionHash)} target="_blank" rel="noreferrer">Confirmed transaction</a>
        {onAuditReceipt ? <button type="button" className="text-button" onClick={() => onAuditReceipt(event)}>Audit receipt</button>
          : <a href={`${fundingExplorer("tx", event.transactionHash)}#eventlog`} target="_blank" rel="noreferrer">Anchored audit receipt</a>}
      </div>
      <small className="field-hint">Confirmed block {String(event.blockNumber)}</small>
      {ESCROW_REFUND_REASON_LABELS[event.refundReason] && <p className="field-hint">Refund reason: {ESCROW_REFUND_REASON_LABELS[event.refundReason]}</p>}
      {event.reason && <p className="field-hint">Recorded reason: {event.reason}</p>}
      {event.reasonHash && validFundingTransaction(event.reasonHash) && <small className="table-row-meta">Reason hash: {event.reasonHash}</small>}
    </li>)}</ol> : <p className="field-hint">Confirmed state history is unavailable. Reconcile the funding records to check contract events.</p>}
  </section>;
}
