import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { getMockFundingPortfolio, MATCHING_LABELS, matchingError } from "../lib/matching.js";
import { findProposal } from "../lib/proposals.js";
import { formatInstant } from "../lib/datetime.js";
import { RELATED_AUDIT_KIND, RelatedAuditReceiptPane } from "./RelatedAuditReceiptPane.jsx";

export function MockFundingPortfolio({ onNavigate }) {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [relatedAudit, setRelatedAudit] = useState(null);
  const relatedAuditRequest = useRef(0);
  useEffect(() => {
    let active = true;
    relatedAuditRequest.current += 1;
    setRelatedAudit(null);
    setLoading(true); setItems([]); setError(""); setTruncated(false);
    if (!user?.id) { setLoading(false); return undefined; }
    getMockFundingPortfolio().then((data) => { if (active) { setItems(data.contributions ?? []); setTruncated(Boolean(data.truncated)); } })
      .catch((err) => { if (active) setError(matchingError(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [user?.id, revision]);
  const openProposalAudit = async (id) => {
    if (!id) return;
    const request = ++relatedAuditRequest.current;
    setRelatedAudit({ kind: RELATED_AUDIT_KIND.PROPOSAL, loading: true, record: null, error: "" });
    try {
      const record = await findProposal(id);
      if (request !== relatedAuditRequest.current) return;
      setRelatedAudit({
        kind: RELATED_AUDIT_KIND.PROPOSAL,
        loading: false,
        record,
        error: record ? "" : "This proposal is no longer available, so its verification receipt cannot be opened.",
      });
    } catch (err) {
      if (request !== relatedAuditRequest.current) return;
      setRelatedAudit({
        kind: RELATED_AUDIT_KIND.PROPOSAL,
        loading: false,
        record: null,
        error: err?.message || "The audit receipt could not be loaded. Try again.",
      });
    }
  };
  return <section className="card-table mock-portfolio" aria-label="Mock funding portfolio">
    {truncated && <p className="field-hint">Showing the first 1,000 mock contributions.</p>}
    <div className="table-header"><div><h3>Mock contributions & refunds</h3><p>Simulated funds held by the app. No wallet funds are transferred.</p></div><button type="button" className="secondary small" disabled={loading} onClick={() => setRevision((value) => value + 1)}>Refresh</button></div>
    {loading ? <p className="table-empty" role="status">Loading mock contributions…</p> : error ? <p className="error-banner" role="alert">{error}</p> : items.length === 0 ? <div className="table-empty"><p>No mock contributions yet.</p><button type="button" className="text-button" onClick={() => onNavigate("discover")}>Find proposals to fund</button></div> : items.map((item) => <div className="table-row" key={item.id}><div><strong>{item.title || "Proposal contribution"}</strong><small className="table-row-meta">{item.currency} {Number(item.amount).toLocaleString()} · {MATCHING_LABELS[item.status] || item.status} · {formatInstant(item.settledAt || item.createdAt)}</small>{item.status === "refunded" && <small className="table-row-meta">Returned to you as mock funds{item.refundReason ? ` · ${item.refundReason.replaceAll("_", " ")}` : ""}</small>}</div><div className="matching-actions">{item.proposalId && <button type="button" className="text-button" disabled={relatedAudit?.loading} onClick={() => openProposalAudit(item.proposalId)}>{relatedAudit?.loading ? "Loading audit receipt…" : "View audit receipt"}</button>}<button type="button" className="text-button" onClick={() => onNavigate(`proposal/${item.proposalId}`)}>View proposal</button></div></div>)}
    {relatedAudit && <RelatedAuditReceiptPane kind={relatedAudit.kind} record={relatedAudit.record} loading={relatedAudit.loading} error={relatedAudit.error} onClose={() => { relatedAuditRequest.current += 1; setRelatedAudit(null); }} />}
  </section>;
}
