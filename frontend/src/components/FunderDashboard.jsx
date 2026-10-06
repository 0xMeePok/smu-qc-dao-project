import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { getFunderDashboard } from "../lib/openFunding.js";
import { escrowExplorer, escrowFundingAmount } from "../lib/escrowFunding.js";
import { findPosting } from "../lib/postings.js";
import { findProposal } from "../lib/proposals.js";
import { RelatedAuditReceiptPane, RELATED_AUDIT_KIND } from "./RelatedAuditReceiptPane.jsx";
import { fundingStateLabel as stateLabel } from "../config/workflowStatus.js";
import { ClaimRemovedFundsButton, FundingApproachList } from "./FundingApproachList.jsx";
import { fundingApproachError, listFundingApproaches } from "../lib/fundingApproach.js";

const money = (item, key) => escrowFundingAmount(item[key], item.tokenDecimals, item.tokenSymbol);

export function FunderDashboard({ onNavigate }) {
  const { user } = useAuth();
  const [data, setData] = useState(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  const [audit, setAudit] = useState(null);
  const [sentApproaches, setSentApproaches] = useState(null);
  const [approachError, setApproachError] = useState("");
  const [approachesLoading, setApproachesLoading] = useState(true);
  const auditRequest = useRef(0);
  useEffect(() => {
    let active = true;
    auditRequest.current++;
    setAudit(null); setData(null); setError(""); setLoading(true);
    setSentApproaches(null); setApproachError(""); setApproachesLoading(true);
    if (!user?.id) { setLoading(false); setApproachesLoading(false); return undefined; }
    getFunderDashboard().then(result => { if (active) setData(result); })
      .catch(err => { if (active) setError(err.message || "Your funding dashboard could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    listFundingApproaches().then(result => { if (active) setSentApproaches(result); })
      .catch(err => { if (active) setApproachError(fundingApproachError(err, "Approaches you sent could not be loaded. Please try again.")); })
      .finally(() => { if (active) setApproachesLoading(false); });
    return () => { active = false; };
  }, [user?.id, revision]);
  const openAudit = async (kind, id) => {
    const version = ++auditRequest.current;
    setAudit({ kind, loading: true });
    try {
      const record = await (kind === RELATED_AUDIT_KIND.LISTING ? findPosting(id) : findProposal(id));
      if (version === auditRequest.current) setAudit({ kind, record, error: record ? "" : "This record is no longer available." });
    } catch (err) {
      if (version === auditRequest.current) setAudit({ kind, error: err.message || "The audit receipt could not be loaded." });
    }
  };
  const links = (item, listing = false) => <div className="table-row-actions">
    <button type="button" className="text-button" onClick={() => onNavigate(`${listing ? "posting" : "proposal"}/${listing ? item.id : item.proposalId}?tab=funding`)}>{listing ? "Manage funding" : "View escrow"}</button>
    <button type="button" className="text-button" onClick={() => openAudit(listing ? RELATED_AUDIT_KIND.LISTING : RELATED_AUDIT_KIND.PROPOSAL, listing ? item.id : item.proposalId)}>Audit receipt</button>
  </div>;
  const group = (name, title, empty, renderItem) => <section className="card-table" aria-label={title}>
    <div className="table-header"><h2>{title}</h2>{name === "opportunities" && <button type="button" className="primary small" onClick={() => onNavigate("create-funding")}>New funding call</button>}</div>
    {!data?.[name]?.length ? <p className="table-empty">{empty}</p> : data[name].map(renderItem)}
    {data?.truncated?.[name] && <p className="field-hint">Showing a limited set of {title.toLowerCase()}. Open individual records for full details.</p>}
  </section>;
  return <section className="page dashboard-page funder-dashboard">
    <div className="page-heading"><div className="eyebrow-row"><span className="role-chip">Funder</span><span>{user?.org}</span></div>
      <h1>Funding dashboard</h1><p>Manage your grant calls and track confirmed proposal commitments, payments and refunds.</p>
      <button className="secondary small" type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh dashboard</button>
    </div>
    {loading ? <p role="status" className="table-empty">Loading your funding dashboard…</p> : error ? <p role="alert" className="error-banner">{error}</p> : <>
      <div className="dashboard-stats-grid funder-totals">
        {[["committed", "Total committed"], ["locked", "Total locked"], ["released", "Total released"], ["refunded", "Total refunded"]].map(([key, label]) => <div className="stat-card" key={key}>
          <h2 className="stat-label">{label}</h2>
          {data?.totals?.length ? data.totals.map(item => <strong className="stat-num" key={`${item.chainId}:${item.tokenAddress}`}>{money(item, key)}</strong>) : <strong className="stat-num">—</strong>}
        </div>)}
      </div>
      <p className="field-hint">Totals are shown per token. Available grant pool funds are shown separately below; amounts count as commitments when transferred into proposal escrow.</p>
      {data?.totalsPartial && <p role="status" className="field-hint">Funding totals are partial. Some records could not be verified or the result is limited. Refresh or open individual proposals for their current balances.</p>}
      {data?.unavailableCommitments > 0 && <p role="status" className="field-hint">{data.unavailableCommitments} commitments could not be verified and are excluded from these totals. Refresh to retry.</p>}
      {data?.unavailablePools > 0 && <p role="status" className="field-hint">{data.unavailablePools} grant pools could not be verified. Open the opportunity or refresh to retry.</p>}
      {data?.unavailableDecisions > 0 && <p role="status" className="field-hint">{data.unavailableDecisions} grant decisions could not be verified and are excluded below. Refresh to retry.</p>}
      {group("opportunities", "My open funding opportunities", "No open funding calls yet. Post a call, then deposit funds to start selecting proposals.", item => <div className="table-row" key={item.id}>
        <div><strong>{item.title || "Untitled funding call"}</strong><small className="table-row-meta">{stateLabel(item.status)} · Indicative budget {item.currency} {Number(item.amount ?? 0).toLocaleString()}</small>
          {item.pool?.poolAddress ? <small className="table-row-meta">Deposited {money(item.pool, "totalDeposited")} · Available {money(item.pool, "available")} · Reserved {money(item.pool, "totalReserved")}</small>
            : <small className="table-row-meta">{item.status === "draft" ? "Private draft" : item.poolUnavailable ? "Grant balance is temporarily unavailable." : item.grantSupported === false ? "Grant pools are awaiting a contract deployment." : "Funds have not been deposited into a grant pool."}</small>}
        </div>{item.status === "draft" ? <button type="button" className="text-button" onClick={() => onNavigate(`create-funding/${item.id}`)}>Resume draft</button> : links(item, true)}
      </div>)}
      {group("commitments", "Proposal commitments", "No verified proposal commitments yet.", item => item.claimFunds ? <div className="table-row" key={item.proposalId}>
        <div><strong>{item.title}</strong><small className="table-row-meta">Removed independent listing. Unpaid deposits can be claimed. Amounts already paid stay paid.</small></div>
        <div className="table-row-actions"><ClaimRemovedFundsButton proposalId={item.proposalId} /></div>
      </div> : <div className="table-row" key={item.proposalId}>
        <div><strong>{item.title}</strong><small className="table-row-meta">{item.postingTitle} · {stateLabel(item.state)}</small>
          <small className="table-row-meta">Committed {money(item, "committed")} · Locked {money(item, "locked")} · Released {money(item, "released")} · Refunded {money(item, "refunded")}</small>
          {item.fundingTarget != null && <small className="table-row-meta">Pooled progress: {money(item, "totalDeposited")} / {money(item, "fundingTarget")}</small>}
          {item.escrowAddress && <a href={escrowExplorer("address", item.escrowAddress)} target="_blank" rel="noreferrer">Escrow contract</a>}
        </div>{links(item)}
      </div>)}
      {group("approaches", "Funding approaches", "No funding approaches received yet.", item => <div className="table-row" key={item.proposalId}>
        <div><strong>{item.title}</strong><small className="table-row-meta">{item.currency} {Number(item.amount ?? 0).toLocaleString()} requested · {stateLabel(item.status)}</small></div>{links(item)}
      </div>)}
      {group("decisions", "Recorded decisions", data?.unavailableDecisions > 0 ? "Verified funding decisions are temporarily unavailable." : "No funding decisions recorded yet.", item => <div className="table-row" key={item.proposalId}>
        <div><strong>{item.title}</strong><small className="table-row-meta">{stateLabel(item.selection?.status ?? item.status)}</small>
          {item.ownerReview?.rationale && <p>{item.ownerReview.rationale}</p>}
          {item.selection?.acceptanceDeadline && <small className="table-row-meta">Acceptance deadline: {new Date(Number(item.selection.acceptanceDeadline) * 1000).toLocaleString()}</small>}
        </div>{links(item)}
      </div>)}
    </>}
    {!loading && !error && <FundingApproachList
      title="Approaches sent to researchers"
      hint="Indicative interest you have registered on independent listings. This is separate from proposals received on your own postings."
      empty="You have not approached a researcher yet."
      items={sentApproaches?.sent ?? []}
      truncated={sentApproaches?.truncated?.sent}
      loading={approachesLoading}
      error={approachError}
      onNavigate={onNavigate}
    />}
    {audit && <RelatedAuditReceiptPane {...audit} onClose={() => { auditRequest.current++; setAudit(null); }} />}
  </section>;
}
