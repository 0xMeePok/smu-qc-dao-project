import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { escrowFundingAmount, getEscrowFundingSummary } from "../lib/escrowFunding.js";

const CLOSED_PAYMENT_STATES = new Set(["cancelled", "refunded", "expired", "voided"]);
const paymentStatus = (item, released) => released ? "paid" : CLOSED_PAYMENT_STATES.has(item.state?.toLowerCase()) ? "no longer payable" : "pending";

export function EscrowReleaseSummary({ onNavigate }) {
  const { user } = useAuth();
  const [data, setData] = useState(null), [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null); setError("");
    if (!user?.id) return undefined;
    getEscrowFundingSummary().then(result => { if (active) setData(result); })
      .catch(err => { if (active) setError(err.message || "Payment summaries could not be loaded."); });
    return () => { active = false; };
  }, [user?.id, revision]);
  if (!user?.id) return null;
  return <section className="card-table escrow-release" aria-label="Escrow payment summary">
    <div className="table-header"><div><h3>Proposal payments</h3><p className="field-hint">Confirmed upfront and completion payments for proposals you own or sponsor.</p></div>
      <button className="secondary small" type="button" onClick={() => setRevision(value => value + 1)}>Refresh payments</button></div>
    {error ? <p className="error-banner" role="alert">{error}</p> : !data ? <p className="table-empty">Loading payments…</p> : <>
      {data.unavailableItems > 0 && <p className="field-hint" role="status">{data.unavailableItems} proposal payment records could not be verified and are excluded. Refresh to retry.</p>}
      {data.truncated && <p className="field-hint" role="status">This payment summary is limited. Open individual proposals for their current payments and balances.</p>}
      {!data.items?.length ? <p className="table-empty">{data.unavailableItems > 0 ? "Verified proposal payments are temporarily unavailable." : "No confirmed escrow payments yet. Open a proposal to view its live escrow."}</p>
        : data.items.map(item => <div className="table-row" key={item.proposalId}><div>
          <strong>{item.title || "Proposal"}</strong><small className="table-row-meta">{item.postingTitle}</small>
          <p>Upfront 50%: {paymentStatus(item, item.upfrontReleased)} · Final 50%: {paymentStatus(item, item.finalReleased)}</p>
          <small>Released before fees: {escrowFundingAmount(item.totalReleased, item.tokenDecimals, item.tokenSymbol)} · Held: {escrowFundingAmount(item.outstandingBalance, item.tokenDecimals, item.tokenSymbol)}</small>
        </div><button type="button" className="text-button" onClick={() => onNavigate(`proposal/${item.proposalId}?tab=funding`)}>Open escrow</button></div>)}
    </>}
  </section>;
}
