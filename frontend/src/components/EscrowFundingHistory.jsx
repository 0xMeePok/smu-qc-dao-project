import { ConvertedAmount } from "./CurrencyAmount.jsx";
import { useState } from "react";
import { formatInstant } from "../lib/datetime.js";
import { escrowEventLabel, escrowExplorer, escrowFundingAmount } from "../lib/escrowFunding.js";
import { shortenAddress } from "../lib/chain.js";
import { FundingContributors } from "./FundingProgress.jsx";
import { EscrowLifecycleTimeline } from "./EscrowLifecycle.jsx";
import { confirmedFundingEvents } from "../lib/fundingDisplay.js";

function ParticipantAddress({ address }) {
  if (!/^0x[0-9a-f]{40}$/i.test(address || "")) return address || "—";
  return <a href={escrowExplorer("address", address)} title={address} aria-label={address} target="_blank" rel="noreferrer">{shortenAddress(address)}</a>;
}

export function EscrowFundingHistory({ data, error, busy, onSync }) {
  const [filter, setFilter] = useState("all");
  const events = confirmedFundingEvents(data?.events ?? []);
  const types = [...new Set(events.map(event => event.type))];
  const visible = events.filter(event => filter === "all" || event.type === filter);
  const summary = data?.summary;
  const reconciliation = data?.reconciliation;
  const reconciled = reconciliation?.complete !== false && (reconciliation?.status === "verified" || reconciliation?.status === "matched" || reconciliation?.matched === true);
  return <section className="detail-section escrow-history" aria-labelledby="escrow-history-title">
    <div className="table-header"><div><h3 id="escrow-history-title">Funding audit trail</h3>
      <p className="field-hint">Confirmed escrow activity checked against the audit registry.</p></div>
      <button type="button" className="secondary small" disabled={busy} onClick={onSync}>{busy ? "Checking…" : "Reconcile funding records"}</button></div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {summary && <FundingContributors summary={summary} stale={Boolean(error)} />}
    {data && <EscrowLifecycleTimeline summary={summary} events={data.lifecycle?.events ?? events} stale={Boolean(error)} />}
    {reconciliation && <p role="status">{reconciled ? "Escrow events match the audit registry." : reconciliation.message || "Funding records are still being checked against the audit registry."}</p>}
    {events.length > 0 && <label className="field-hint">Event type <select aria-label="Filter funding events" value={filter} onChange={event => setFilter(event.target.value)}>
      <option value="all">All funding events</option>{types.map(type => <option key={type} value={type}>{escrowEventLabel(type)}</option>)}
    </select></label>}
    {visible.length ? <><p className="audit-scroll-hint field-hint">Scroll the table sideways to see all columns.</p><div className="audit-table-scroll" role="region" aria-label="Escrow funding events" tabIndex={0}><table className="audit-nav-table">
      <thead><tr><th scope="col">Event</th><th scope="col">Amount</th><th scope="col">Participants</th><th scope="col">Record</th></tr></thead>
      <tbody>{visible.map((event, index) => <tr key={event.id ?? `${event.transactionHash}:${event.logIndex ?? index}`}>
        <td>{escrowEventLabel(event.type)}</td>
        <td><ConvertedAmount text={escrowFundingAmount(event.amountBaseUnits, event.tokenDecimals ?? summary?.tokenDecimals, event.tokenSymbol ?? summary?.tokenSymbol)} /></td>
        <td><small>Actor: <ParticipantAddress address={event.actor} /></small><br /><small>Counterparty: <ParticipantAddress address={event.counterparty} /></small></td>
        <td>{event.transactionHash && <a href={escrowExplorer("tx", event.transactionHash)} target="_blank" rel="noreferrer">View transaction</a>}<br /><small>Block {event.blockNumber ?? "—"}</small>
          {Number.isFinite(event.timestamp) && <><br /><time dateTime={new Date(event.timestamp * 1000).toISOString()}>{formatInstant(new Date(event.timestamp * 1000))}</time></>}</td>
      </tr>)}</tbody>
    </table></div></> : <p className="field-hint">{data ? "No confirmed funding events for this filter." : "Loading confirmed funding activity…"}</p>}
  </section>;
}
