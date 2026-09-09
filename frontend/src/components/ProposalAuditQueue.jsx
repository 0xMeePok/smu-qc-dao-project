import { useEffect, useMemo, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase.js";
import { AuditReceipt } from "./AuditReceipt.jsx";
import { AuditDetailPane } from "./AuditDetailPane.jsx";
import { formatInstant } from "../lib/datetime.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { postingAuditReceipt, readPostingAudit } from "../lib/postingAudit.js";
import {
  fundingOpportunityAuditReceipt,
  readFundingOpportunityAudit,
} from "../lib/fundingOpportunityAudit.js";

const LABELS = {
  "waiting-wallet": "Waiting for researcher wallet",
  pending: "Confirmation pending",
  failed: "Needs attention",
  confirmed: "Confirmed",
};

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

function listingKind(opportunity) {
  if (!opportunity) return "Unavailable";
  return opportunity.opportunityType === OPEN_FUNDING_TYPE ? "Open funding" : "Problem statement";
}

function groupByParent(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.opportunity?.id || "__missing__";
    if (!groups.has(key)) {
      groups.set(key, { key, opportunity: item.opportunity || null, items: [] });
    }
    groups.get(key).items.push(item);
  }
  for (const group of groups.values()) {
    group.items.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }
  return [...groups.values()];
}

export function ProposalAuditQueue() {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [paneTab, setPaneTab] = useState("proposal");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const request = useRef(0);

  const load = async (next = null, status = statusFilter) => {
    const generation = ++request.current;
    setLoading(true); setError("");
    try {
      const payload = { cursor: next };
      if (status && status !== "all") payload.status = status;
      const { data } = await httpsCallable(functions, "adminListProposalAudits")(payload);
      if (generation !== request.current) return;
      setItems((old) => next ? [...old, ...data.items.filter((item) => !old.some((existing) => existing.id === item.id))] : data.items);
      setCursor(data.cursor);
    } catch (err) { if (generation === request.current) setError(err.message || "The verification queue could not be loaded. Try refreshing."); }
    finally { if (generation === request.current) setLoading(false); }
  };

  useEffect(() => {
    setItems([]);
    setCursor(null);
    void load(null, statusFilter);
    return () => { ++request.current; };
  }, [statusFilter]);

  const retry = async (item) => {
    if (busy) return;
    setBusy(item.id); setError(""); setMessage("");
    try {
      const { data } = await httpsCallable(functions, "adminRetryProposalAudit")({ proposalId: item.id });
      setMessage(data.message); await load(null, statusFilter);
    } catch (err) { setError(err.message || "Verification could not be retried. The proposal is still saved."); }
    finally { setBusy(null); }
  };

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => (
      (item.title || "").toLowerCase().includes(needle)
      || (item.opportunity?.title || "").toLowerCase().includes(needle)
    ));
  }, [items, search]);

  const groups = useMemo(() => groupByParent(visible), [visible]);

  return (
    <section aria-label="Proposal verification queue" className="proposal-audit-queue">
      <div className="page-heading">
        <span className="eyebrow">Proposal audit trail</span>
        <h2>Verification queue</h2>
        <p>Proposal submissions stay saved while verification catches up. Pending transactions retry automatically up to three times with increasing delays.</p>
      </div>
      <div className="table-controls-bar audit-toolbar-sticky">
        <div className="search-filter-group">
          <div className="search-box">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search proposal or listing title…"
              aria-label="Search proposal or listing title"
            />
          </div>
          <select
            className="audit-filter-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter by verification status"
          >
            <option value="all">All statuses</option>
            <option value="attention">Needs attention</option>
            <option value="pending">Pending</option>
            <option value="confirmed">Confirmed</option>
          </select>
        </div>
        <button type="button" className="secondary small" onClick={() => load(null, statusFilter)} disabled={loading || Boolean(busy)}>Refresh queue</button>
      </div>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {message && <p className="proposal-success" role="status">{message}</p>}
      {loading && <p role="status">Loading verification queue…</p>}
      {!loading && !error && !items.length && <p>No proposal verification jobs yet.</p>}
      {!loading && items.length > 0 && !visible.length && (
        <p className="submission-log-empty">No jobs match the current search.</p>
      )}
      {groups.map((group) => (
        <div className="audit-nav-group" key={group.key}>
          <h3 className="audit-group-header">
            {group.opportunity
              ? `${group.opportunity.title || "Untitled"} · ${listingKind(group.opportunity)}`
              : "Parent listing is no longer available."}
          </h3>
          <table className="audit-nav-table">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Proposal</th>
                <th scope="col">Updated</th>
                <th scope="col">Attempts</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {group.items.map((item) => (
                <tr className="audit-nav-row" key={item.id}>
                  <td><span className={`submission-status-badge badge-audit-${item.status || "none"}`}>{LABELS[item.status] || item.status}</span></td>
                  <td>
                    <strong>{item.title}</strong>
                    <div className="table-row-meta"><code>proposals/{item.id}</code></div>
                  </td>
                  <td>{formatInstant(item.updatedAt)}</td>
                  <td>{item.attemptCount}/3</td>
                  <td>
                    <div className="audit-nav-actions">
                      <button type="button" className="secondary small" onClick={() => { setSelected(item); setPaneTab("proposal"); }}>View receipts</button>
                      {item.status !== "confirmed" && (
                        <button type="button" className="secondary small" disabled={Boolean(busy)} onClick={() => retry(item)}>
                          {busy === item.id ? "Checking…" : item.transactionHash ? "Retry confirmation" : "Reset wallet attempts"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {cursor && (
        <div className="submission-log-more">
          <button type="button" className="secondary" disabled={loading} onClick={() => load(cursor, statusFilter)}>Load more receipts</button>
        </div>
      )}
      {selected && (
        <AuditDetailPane
          title={selected.title}
          onClose={() => setSelected(null)}
          tabs={selected.opportunity
            ? [{ id: "proposal", label: "Proposal receipt" }, { id: "listing", label: "Listing receipt" }]
            : [{ id: "proposal", label: "Proposal receipt" }]}
          activeTab={paneTab}
          onTabChange={setPaneTab}
        >
          {paneTab === "listing" && selected.opportunity
            ? <ListingReceipt opportunity={selected.opportunity} />
            : (
              <>
                {selected.opportunity
                  ? <p className="field-hint"><strong>Responds to</strong> {selected.opportunity.title} · {listingKind(selected.opportunity)} · <code>problems/{selected.opportunity.id}</code></p>
                  : <p className="field-hint">Parent listing is no longer available.</p>}
                <AuditReceipt
                  audit={selected.audit}
                  entityLabel="Proposal"
                  eventLabel="Proposal submitted"
                  actorRole="Researcher / solution developer"
                  firebaseReference={`proposals/${selected.id}`}
                  onVerify={async () => (await httpsCallable(functions, "adminVerifyProposalAudit")({ proposalId: selected.id })).data}
                />
              </>
            )}
        </AuditDetailPane>
      )}
    </section>
  );
}
