import { useEffect, useRef, useState } from "react";
import {
  ACTOR_ROLE_OPTIONS,
  AUDIT_EVENT_OPTIONS,
  VERIFICATION_OPTIONS,
  actorRoleLabel,
} from "../../../firebase/functions/auditTrailCatalog.js";
import { listAuditTrail } from "../lib/auditTrail.js";
import { messageForFirebaseError } from "../lib/errors.js";
import { formatInstant } from "../lib/datetime.js";
import { highlightElement } from "../lib/highlightTarget.js";
import { findProposal } from "../lib/proposals.js";
import { StatusBadge } from "./StatusBadge.jsx";
import { EscrowAuditDetails } from "./EscrowAuditDetails.jsx";
import { RELATED_AUDIT_KIND, RelatedAuditReceiptPane } from "./RelatedAuditReceiptPane.jsx";

const EMPTY = { types: [], from: "", to: "", role: "", related: "", verify: "" };

function readFilters() {
  const params = new URLSearchParams(window.location.hash.split("?")[1] || "");
  const type = (params.get("auditTypes") || "").split(",").find((id) => AUDIT_EVENT_OPTIONS.some(([option]) => option === id));
  return {
    types: type ? [type] : [],
    from: params.get("auditFrom") || "",
    to: params.get("auditTo") || "",
    role: ACTOR_ROLE_OPTIONS.some(([id]) => id === params.get("auditRole")) ? params.get("auditRole") : "",
    related: params.get("auditEntity") || "",
    verify: VERIFICATION_OPTIONS.some(([id]) => id === params.get("auditVerify")) ? params.get("auditVerify") : "",
  };
}

function writeFilters(filters) {
  const [path, query = ""] = window.location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const set = (key, value) => { if (value) params.set(key, value); else params.delete(key); };
  set("auditTypes", filters.types.join(","));
  set("auditFrom", filters.from);
  set("auditTo", filters.to);
  set("auditRole", filters.role);
  set("auditEntity", filters.related);
  set("auditVerify", filters.verify);
  const next = params.toString();
  const hash = `#${path || ""}${next ? `?${next}` : ""}`;
  if (window.location.hash !== hash) window.history.replaceState(window.history.state, "", hash);
}

function requestBody(filters, scope, entityId, cursor) {
  return {
    ...(scope === "admin" ? {} : { entityType: scope, entityId }),
    eventTypes: filters.types,
    ...(filters.from ? { startDate: filters.from } : {}),
    ...(filters.to ? { endDate: filters.to } : {}),
    ...(filters.role ? { actorRole: filters.role } : {}),
    ...(filters.verify ? { verification: filters.verify } : {}),
    ...(filters.related ? { related: filters.related } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export function ConsolidatedAuditTrail({ scope, entityId = "", onOpenComment, onNavigate }) {
  const [filters, setFilters] = useState(readFilters);
  const [items, setItems] = useState([]);
  const [count, setCount] = useState(0);
  const [cursor, setCursor] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState(null);
  const requestId = useRef(0);
  const receiptRequest = useRef(0);
  const options = AUDIT_EVENT_OPTIONS.filter(([id]) => scope === "admin" || id !== "governance");
  const active = Boolean(filters.types.length || filters.from || filters.to || filters.role || filters.related || filters.verify);
  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    const sync = () => setFilters(readFilters());
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  useEffect(() => { writeFilters(filters); }, [filterKey]);

  useEffect(() => {
    if (scope !== "admin" && !entityId) return undefined;
    const request = ++requestId.current;
    setLoading(true);
    setError("");
    setCursor(null);
    listAuditTrail(requestBody(filters, scope, entityId))
      .then((data) => {
        if (request !== requestId.current) return;
        setItems(data.items || []);
        setCount(data.count || 0);
        setCursor(data.nextCursor || null);
        setTruncated(Boolean(data.truncated));
      })
      .catch((err) => { if (request === requestId.current) setError(messageForFirebaseError(err)); })
      .finally(() => { if (request === requestId.current) setLoading(false); });
    return undefined;
  }, [filterKey, scope, entityId]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const request = requestId.current;
    setLoadingMore(true);
    setError("");
    try {
      const data = await listAuditTrail(requestBody(filters, scope, entityId, cursor));
      if (request !== requestId.current) return;
      setItems((current) => [...current, ...(data.items || [])]);
      setCursor(data.nextCursor || null);
    } catch (err) {
      if (request === requestId.current) setError(messageForFirebaseError(err));
    } finally {
      if (request === requestId.current) setLoadingMore(false);
    }
  };

  const openReceipt = async (item) => {
    highlightElement(`audit-trail-${item.id}`);
    const request = ++receiptRequest.current;
    setReceipt({ kind: RELATED_AUDIT_KIND.PROPOSAL, loading: true, record: null, error: "" });
    try {
      const record = await findProposal(item.proposalId || item.entityId);
      if (request !== receiptRequest.current) return;
      setReceipt({
        kind: RELATED_AUDIT_KIND.PROPOSAL,
        loading: false,
        record,
        error: record ? "" : "This proposal is no longer available, so its verification receipt cannot be opened.",
      });
    } catch (err) {
      if (request !== receiptRequest.current) return;
      setReceipt({ kind: RELATED_AUDIT_KIND.PROPOSAL, loading: false, record: null, error: err?.message || "The audit receipt could not be loaded. Try again." });
    }
  };

  const openComment = (item) => {
    highlightElement(`audit-trail-${item.id}`);
    if (onOpenComment) onOpenComment(item);
    else if (onNavigate && item.proposalId) onNavigate(`proposal/${item.proposalId}?comment=${item.commentId}`);
  };

  return (
    <section className="audit-trail-panel" aria-label="Audit trail">
      <div className="audit-trail-heading">
        <h2>Audit trail</h2>
        <p>One chronological list of workflow events on records you can view. Anchored events link to a verification receipt. Evaluator recommendations stay off-chain and are not verified on-chain.</p>
      </div>
      <form className="audit-trail-filters" onSubmit={(event) => event.preventDefault()}>
        <div className="audit-trail-filter-row">
          <label>Event type
            <select value={filters.types[0] || ""} onChange={(event) => setFilters((current) => ({ ...current, types: event.target.value ? [event.target.value] : [] }))}>
              <option value="">All event types</option>
              {options.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <label>From <input type="date" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} /></label>
          <label>To <input type="date" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} /></label>
          <label>Actor role
            <select value={filters.role} onChange={(event) => setFilters((current) => ({ ...current, role: event.target.value }))}>
              <option value="">All roles</option>
              {ACTOR_ROLE_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <label>Verification
            <select value={filters.verify} onChange={(event) => setFilters((current) => ({ ...current, verify: event.target.value }))}>
              <option value="">Any status</option>
              {VERIFICATION_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <label>Related record
            <input value={filters.related} placeholder="Record id or name" onChange={(event) => setFilters((current) => ({ ...current, related: event.target.value }))} />
          </label>
          <button type="button" className="secondary small" disabled={!active} onClick={() => setFilters(EMPTY)}>Clear filters</button>
        </div>
      </form>
      <p className="audit-trail-count" role="status" aria-live="polite">
        {loading ? "Loading audit trail…" : `${count} ${count === 1 ? "event" : "events"}`}
        {!loading && truncated ? " · Latest matching records only." : ""}
      </p>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {!loading && !error && items.length === 0 && (
        <div className="audit-trail-empty">
          <h3>{active ? "No events match these filters" : "No workflow events yet"}</h3>
          <p>{active ? "Clear the filters to see the rest of this trail." : "Events appear here as proposals, recommendations, decisions, moderation and funding are recorded."}</p>
        </div>
      )}
      {items.length > 0 && (
        <ol className="audit-trail-list">
          {items.map((item) => (
            <li key={item.id} id={`audit-trail-${item.id}`} className="audit-trail-event">
              <div className="audit-trail-event-top">
                <h3>{item.label}</h3>
                <time dateTime={item.at}>{formatInstant(item.at)}</time>
              </div>
              <p>{item.description}</p>
              <p className="audit-trail-meta">
                <span>{actorRoleLabel(item.actorRole)} · {item.actorLabel}</span>
                <span>{item.entityLabel}</span>
                <span className={`audit-trail-verify is-${item.verification}`}>{item.verificationLabel}</span>
              </p>
              <EscrowAuditDetails funding={item.funding} />
              {item.recommendation && <StatusBadge status={item.recommendation} prefix="Evaluator · " interactive={false} />}
              {!item.recommendation && item.workflowStatus && <StatusBadge status={item.workflowStatus} interactive={false} />}
              {((item.receiptKind && item.proposalId) || item.commentId) && <div className="record-jumps">
                {item.receiptKind && item.proposalId && (
                  <button type="button" className="record-jump" onClick={() => openReceipt(item)}>View audit receipt</button>
                )}
                {item.commentId && (
                  <button type="button" className="record-jump" onClick={() => openComment(item)}>View comment</button>
                )}
              </div>}
            </li>
          ))}
        </ol>
      )}
      {cursor && (
        <button type="button" className="secondary" disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? "Loading…" : "Load older trail events"}
        </button>
      )}
      {receipt && (
        <RelatedAuditReceiptPane
          kind={receipt.kind}
          record={receipt.record}
          loading={receipt.loading}
          error={receipt.error}
          onClose={() => { receiptRequest.current += 1; setReceipt(null); }}
        />
      )}
    </section>
  );
}
