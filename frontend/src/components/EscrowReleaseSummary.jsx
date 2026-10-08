import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext.jsx";
import { escrowFundingAmount, getEscrowFundingSummary } from "../lib/escrowFunding.js";

const CLOSED_PAYMENT_STATES = new Set(["cancelled", "refunded", "expired", "voided"]);
const paymentStatus = (item, released) => released ? "paid" : CLOSED_PAYMENT_STATES.has(item.state?.toLowerCase()) ? "no longer payable" : "pending";

export function EscrowReleaseSummary({ onNavigate }) {
  const { user } = useAuth();
  // Keep the last verified display when returning to the tab, while still
  // checking a fresh confirmed block on every mount. The wallet key prevents
  // another account's payments from appearing during sign-in or switching.
  const payments = useQuery({
    queryKey: ["escrowFundingSummary", user?.id?.toLowerCase()],
    queryFn: getEscrowFundingSummary,
    enabled: Boolean(user?.id),
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { data } = payments;
  const error = payments.error?.message || (payments.error ? "Payment summaries could not be loaded." : "");
  if (!user?.id) return null;
  return <section className="card-table escrow-release" aria-label="Escrow payment summary">
    <div className="table-header"><div><h3>Proposal payments</h3><p className="field-hint">Confirmed upfront and completion payments for proposals you own or sponsor.</p></div>
      <button className="secondary small" type="button" disabled={payments.isFetching} onClick={() => payments.refetch()}>Refresh payments</button></div>
    {error && <p className="error-banner" role="alert">{error}{data && " Showing last verified results; open an escrow to check its current payments."}</p>}
    {data && payments.isFetching && <p className="field-hint" role="status">Refreshing payments… Showing last verified results.</p>}
    {!data ? !error && <p className="table-empty" role="status">Loading payments…</p> : <>
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
