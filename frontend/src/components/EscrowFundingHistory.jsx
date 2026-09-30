import { useState } from "react";
import { escrowEventLabel, escrowExplorer, escrowFundingAmount } from "../lib/escrowFunding.js";

export function EscrowFundingHistory({ data, error, busy, onSync }) {
  const [filter, setFilter] = useState("all");
  const events = data?.events ?? [];
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
    {reconciliation && <p role="status">{reconciled ? "Escrow events match the audit registry." : reconciliation.message || "Funding records are still being checked against the audit registry."}</p>}
    {events.length > 0 && <label className="field-hint">Event type <select aria-label="Filter funding events" value={filter} onChange={event => setFilter(event.target.value)}>
      <option value="all">All funding events</option>{types.map(type => <option key={type} value={type}>{escrowEventLabel(type)}</option>)}
    </select></label>}
    {visible.length ? <div className="audit-table-scroll" role="region" aria-label="Escrow funding events" tabIndex={0}><table className="audit-nav-table">
      <thead><tr><th scope="col">Event</th><th scope="col">Amount</th><th scope="col">Participants</th><th scope="col">Record</th></tr></thead>
      <tbody>{visible.map((event, index) => <tr key={event.id ?? `${event.transactionHash}:${event.logIndex ?? index}`}>
        <td>{escrowEventLabel(event.type)}</td>
        <td>{escrowFundingAmount(event.amountBaseUnits, event.tokenDecimals ?? summary?.tokenDecimals, event.tokenSymbol ?? summary?.tokenSymbol)}</td>
        <td><small>Actor: {event.actor || "—"}</small><br /><small>Counterparty: {event.counterparty || "—"}</small></td>
        <td>{event.transactionHash && <a href={escrowExplorer("tx", event.transactionHash)} target="_blank" rel="noreferrer">View transaction</a>}<br /><small>Block {event.blockNumber ?? "—"}</small>
          {Number.isFinite(event.timestamp) && <><br /><time dateTime={new Date(event.timestamp * 1000).toISOString()}>{new Date(event.timestamp * 1000).toLocaleString()}</time></>}</td>
      </tr>)}</tbody>
    </table></div> : <p className="field-hint">{data ? "No confirmed funding events for this filter." : "Loading confirmed funding activity…"}</p>}
  </section>;
}
