import { useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase.js";
import { AuditReceipt } from "./AuditReceipt.jsx";
import { formatInstant } from "../lib/datetime.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { postingAuditReceipt, readPostingAudit } from "../lib/postingAudit.js";
import {
  fundingOpportunityAuditReceipt,
  readFundingOpportunityAudit,
} from "../lib/fundingOpportunityAudit.js";

const LABELS = { "waiting-wallet": "Waiting for researcher wallet", pending: "Confirmation pending", failed: "Needs attention", confirmed: "Confirmed" };

function opportunityForAudit(opportunity) {
  if (!opportunity) return null;
  return {
    ...opportunity,
    expiresAt: opportunity.expiresAt ? new Date(opportunity.expiresAt) : opportunity.expiresAt,
  };
}

function ListingReceipt({ opportunity }) {
  const record = opportunityForAudit(opportunity);
  const isOpenFunding = record.opportunityType === OPEN_FUNDING_TYPE;
  let receipt = record.audit;
  try {
    receipt = (isOpenFunding
      ? fundingOpportunityAuditReceipt(record)
      : postingAuditReceipt(record)) || record.audit;
  } catch {
    receipt = record.audit;
  }
  return (
    <AuditReceipt
      audit={receipt || record.audit}
      entityLabel={isOpenFunding ? "Funding opportunity" : "Posting"}
      eventLabel={isOpenFunding
        ? "Open funding opportunity submitted"
        : "Funded problem statement submitted"}
      actorRole={isOpenFunding ? "Funder" : "Problem owner"}
      firebaseReference={`problems/${record.id}`}
      onVerify={() => (isOpenFunding ? readFundingOpportunityAudit(record) : readPostingAudit(record))}
    />
  );
}

export function ProposalAuditQueue() {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [expandedProposal, setExpandedProposal] = useState(null);
  const [expandedListing, setExpandedListing] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const request = useRef(0);
  const load = async (next = null) => {
    const generation = ++request.current;
    setLoading(true); setError("");
    try {
      const { data } = await httpsCallable(functions, "adminListProposalAudits")({ cursor: next });
      if (generation !== request.current) return;
      setItems((old) => next ? [...old, ...data.items.filter((item) => !old.some((existing) => existing.id === item.id))] : data.items);
      setCursor(data.cursor);
    } catch (err) { if (generation === request.current) setError(err.message || "The verification queue could not be loaded. Try refreshing."); }
    finally { if (generation === request.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { ++request.current; }; }, []);
  const retry = async (item) => {
    if (busy) return;
    setBusy(item.id); setError(""); setMessage("");
    try {
      const { data } = await httpsCallable(functions, "adminRetryProposalAudit")({ proposalId: item.id });
      setMessage(data.message); await load();
    } catch (err) { setError(err.message || "Verification could not be retried. The proposal is still saved."); }
    finally { setBusy(null); }
  };
  return <section aria-label="Proposal verification queue" className="proposal-audit-queue">
    <div className="page-heading"><span className="eyebrow">Proposal audit trail</span><h2>Verification queue</h2>
      <p>Proposal submissions stay saved while verification catches up. Pending transactions retry automatically up to three times with increasing delays.</p>
      <button type="button" className="secondary" onClick={() => load()} disabled={loading || Boolean(busy)}>Refresh queue</button>
    </div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {message && <p className="proposal-success" role="status">{message}</p>}
    {loading && <p role="status">Loading verification queue…</p>}
    {!loading && !error && !items.length && <p>No proposal verification jobs yet.</p>}
    {items.map((item) => <article className="audit-item-card" key={item.id}>
      <h3>{item.title}</h3><p><strong>{LABELS[item.status] || item.status}</strong> · {item.attemptCount}/3 confirmation attempts</p>
      <p className="audit-reference">proposals/{item.id}</p>
      {item.opportunity
        ? (
          <p>
            <strong>Responds to</strong> {item.opportunity.title || "Untitled"}
            {" · "}
            {item.opportunity.opportunityType === OPEN_FUNDING_TYPE ? "Open funding" : "Problem statement"}
            {" · "}
            <code>problems/{item.opportunity.id}</code>
          </p>
        )
        : <p>Parent listing is no longer available.</p>}
      <p>Updated {formatInstant(item.updatedAt)}{item.status === "pending" ? ` · Next check ${formatInstant(item.nextAttemptAt)}` : ""}</p>
      {item.lastError && <p role="status">{item.lastError}</p>}
      <div className="form-actions">
        <button type="button" className="secondary" onClick={() => setExpandedProposal(expandedProposal === item.id ? null : item.id)}>{expandedProposal === item.id ? "Hide receipt" : "View receipt"}</button>
        {item.opportunity && (
          <button type="button" className="secondary" onClick={() => setExpandedListing(expandedListing === item.id ? null : item.id)}>{expandedListing === item.id ? "Hide listing receipt" : "View listing receipt"}</button>
        )}
        {item.status !== "confirmed" && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => retry(item)}>{busy === item.id ? "Checking…" : item.transactionHash ? "Retry confirmation" : "Reset wallet attempts"}</button>}
      </div>
      {expandedProposal === item.id && <AuditReceipt audit={item.audit} entityLabel="Proposal" eventLabel="Proposal submitted" actorRole="Researcher / solution developer" firebaseReference={`proposals/${item.id}`}
        onVerify={async () => (await httpsCallable(functions, "adminVerifyProposalAudit")({ proposalId: item.id })).data} />}
      {expandedListing === item.id && item.opportunity && <ListingReceipt opportunity={item.opportunity} />}
    </article>)}
    {cursor && <button type="button" className="secondary" disabled={loading} onClick={() => load(cursor)}>Load more receipts</button>}
  </section>;
}
