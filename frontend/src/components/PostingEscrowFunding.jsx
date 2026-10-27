import { ConvertedAmount } from "./CurrencyAmount.jsx";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext.jsx";
import { useLiveActivity } from "../hooks/useLiveActivity.js";
import { LIVE_DASHBOARD_OPTIONS } from "../lib/liveDashboard.js";
import { escrowFundingAmount, getPostingEscrowFundingSummary } from "../lib/escrowFunding.js";
import { escrowErrorMessage } from "../lib/escrow.js";
import { EscrowCustodyNotice } from "./EscrowCustodyNotice.jsx";
import { FundingProgress, FundingContributors } from "./FundingProgress.jsx";
import { EscrowLifecycleBadge, EscrowMoneySummary, EscrowLifecycleTimeline } from "./EscrowLifecycle.jsx";

/** Financial reads mount only when the posting's funding tab is opened. */
export function PostingEscrowFunding({ problemId, active = true, onNavigate }) {
  const { user } = useAuth();
  const query = useQuery({ ...LIVE_DASHBOARD_OPTIONS,
    queryKey: ["postingEscrowFunding", user?.id, problemId],
    queryFn: () => getPostingEscrowFundingSummary(problemId), enabled: Boolean(user?.id && problemId && active),
    staleTime: 30_000 });
  useLiveActivity({ problemId, channel: "funding", identity: user?.id, onRefresh: () => query.refetch(),
    enabled: Boolean(user?.id && problemId && active), blocked: query.isFetching });
  const data = query.data;
  return <section className="card-table" aria-label="Posting escrow custody">
    <div className="table-header"><div><h3>Escrow funding and custody</h3>
      <p>Each proposal holds its own contributions. Ordinary withdrawals stay blocked while its funding window is open.</p></div>
      <button type="button" className="secondary small" disabled={query.isFetching} onClick={() => query.refetch()}>Refresh custody</button>
    </div>
    {query.isPending && <p role="status">Reading confirmed proposal custody…</p>}
    {query.error && <p role="alert" className="error-banner">{escrowErrorMessage(query.error)}{data && " Previously loaded custody is shown; refresh before relying on it."}</p>}
    {data?.items?.length === 0 && <p className="table-empty">No escrow-backed proposals are available on this posting yet.</p>}
    {data?.items?.map(item => <article className="table-row" key={item.proposalId}>
      <div><strong>{item.title}</strong>
        {item.available === false ? <p className="field-hint">Funding and lock status could not be verified. Open the proposal to check its original escrow.</p> : <>
          <small className="table-row-meta">Confirmed deposits <ConvertedAmount text={escrowFundingAmount(item.totalDeposited, item.tokenDecimals, item.tokenSymbol)} /> / <ConvertedAmount text={escrowFundingAmount(item.fundingTarget, item.tokenDecimals, item.tokenSymbol)} /></small>
          <FundingProgress summary={item} compact stale={Boolean(query.error)} label={`Confirmed funding progress for ${item.title}`} />
          <EscrowLifecycleBadge summary={item} stale={Boolean(query.error)} />
          <EscrowMoneySummary summary={item} compact stale={Boolean(query.error)} />
          <EscrowCustodyNotice summary={item} stale={Boolean(query.error)} />
          <details><summary>Contributors and state history</summary>
            <FundingContributors summary={item} stale={Boolean(query.error)} />
            <EscrowLifecycleTimeline summary={item} events={item.lifecycle?.events ?? []} stale={Boolean(query.error)} />
          </details>
          {item.selectionGate?.canSelect && <p className="queue-note queue-note-ready">Funding requirement met. The posting owner may select this proposal. Evaluator feedback is optional.</p>}
          {item.state === "Open" && !item.selectionGate?.canSelect && <p className="field-hint">{item.selectionBlockReason || (item.fundingRequirementMet
            ? "Selection is unavailable until the posting is active and open."
            : "Selection requires the full target in confirmed escrow custody.")}</p>}
        </>}
      </div>
      <div className="table-row-actions"><button type="button" className="text-button" onClick={() => onNavigate?.(`proposal/${item.proposalId}?tab=funding`)}>Open escrow</button></div>
    </article>)}
    {data?.unavailableItems > 0 && <p role="status" className="field-hint">Some escrow balances could not be verified. They are not counted as meeting the funding requirement.</p>}
    {data?.truncated && <p className="field-hint">Showing up to 50 proposals. Open an individual proposal for its verified funding status.</p>}
  </section>;
}
