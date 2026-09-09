import { useEffect, useRef, useState } from "react";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
} from "firebase/firestore";
import { db } from "../lib/firebase.js";
import { formatInstant } from "../lib/datetime.js";
import { shortenAddress } from "../lib/chain.js";
import { categoryLabel } from "../config/postingCategories.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { postingAuditReceipt, readPostingAudit } from "../lib/postingAudit.js";
import {
  fundingOpportunityAuditReceipt,
  readFundingOpportunityAudit,
} from "../lib/fundingOpportunityAudit.js";
import { AuditReceipt } from "./AuditReceipt.jsx";

const PAGE_SIZE = 25;
const MAX_FILTER_SCANS = 8;
const VISIBLE_STATUSES = ["submitted", "open", "cancelled"];

const STATUS_LABELS = {
  submitted: "Submitted",
  open: "Open",
  cancelled: "Withdrawn",
};

function StatusBadge({ status }) {
  return (
    <span className={`submission-status-badge badge-${status}`}>
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function AuditStatusBadge({ audit }) {
  if (!audit) return <span className="submission-status-badge badge-none">No receipt</span>;
  const label = {
    confirmed: "Confirmed",
    pending: "Pending",
    failed: "Needs attention",
    queued: "Queued",
    submitted: "Submitted",
  }[audit.status] || audit.status;
  return (
    <span className={`submission-status-badge badge-audit-${audit.status || "none"}`}>
      {label}
    </span>
  );
}

function formatAmount(amount, currency) {
  if (amount == null || amount === "") return "—";
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return "—";
  return `${currency || ""} ${numeric.toLocaleString()}`.trim();
}

function isProblemStatement(item) {
  return item.opportunityType !== OPEN_FUNDING_TYPE;
}

function fromDoc(docSnap) {
  return { id: docSnap.id, ...docSnap.data() };
}

function receiptFor(item, variant) {
  try {
    return variant.receipt(item) || item.audit || null;
  } catch {
    return item.audit || null;
  }
}

function statusFilters(statusFilter) {
  return statusFilter === "all"
    ? [where("status", "in", VISIBLE_STATUSES)]
    : [where("status", "==", statusFilter)];
}

async function fetchPage({ kind, statusFilter, cursor }) {
  const constraints = kind === "funding"
    ? [where("opportunityType", "==", OPEN_FUNDING_TYPE), ...statusFilters(statusFilter)]
    : statusFilters(statusFilter);

  const run = (after) => getDocs(query(
    collection(db, "problems"),
    ...constraints,
    orderBy("createdAt", "desc"),
    ...(after ? [startAfter(after)] : []),
    limit(PAGE_SIZE),
  ));

  if (kind === "funding") {
    const snapshot = await run(cursor);
    return {
      items: snapshot.docs.map(fromDoc),
      cursor: snapshot.docs[snapshot.docs.length - 1] || null,
      hasMore: snapshot.docs.length === PAGE_SIZE,
    };
  }

  // Problem statements share `problems` with open funding and have no stored
  // discriminator on historical docs, so pages are scanned and filtered here.
  const items = [];
  let nextCursor = cursor;
  let hasMore = true;
  for (let scan = 0; scan < MAX_FILTER_SCANS && items.length < PAGE_SIZE; scan += 1) {
    const snapshot = await run(nextCursor);
    if (snapshot.empty) {
      nextCursor = null;
      hasMore = false;
      break;
    }
    nextCursor = snapshot.docs[snapshot.docs.length - 1];
    hasMore = snapshot.docs.length === PAGE_SIZE;
    items.push(...snapshot.docs.map(fromDoc).filter(isProblemStatement));
    if (!hasMore) break;
  }

  return { items, cursor: nextCursor, hasMore };
}

const VARIANTS = {
  posting: {
    label: "Problem statement submission logs",
    eyebrow: "Problem statements",
    description: "Marketplace-visible and withdrawn problem statements, with their audit status. Drafts stay private to their owners.",
    empty: "No problem statement submissions found for the selected filter.",
    loading: "Loading problem statement logs…",
    error: "Failed to load problem statement logs.",
    fundingLabel: "Funding",
    eventLabel: "Funded problem statement submitted",
    actorRole: "Problem owner",
    entityLabel: "Posting",
    receipt: postingAuditReceipt,
    readAudit: readPostingAudit,
  },
  funding: {
    label: "Open funding submission logs",
    eyebrow: "Open funding",
    description: "Marketplace-visible and withdrawn open funding opportunities, with their audit status. Drafts stay private to their owners.",
    empty: "No open funding submissions found for the selected filter.",
    loading: "Loading open funding logs…",
    error: "Failed to load open funding logs.",
    fundingLabel: "Indicative funding",
    eventLabel: "Open funding opportunity submitted",
    actorRole: "Funder",
    entityLabel: "Funding opportunity",
    receipt: fundingOpportunityAuditReceipt,
    readAudit: readFundingOpportunityAudit,
  },
};

function SubmissionLogs({ kind }) {
  const variant = VARIANTS[kind];
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expanded, setExpanded] = useState(null);
  const cursorRef = useRef(null);
  const request = useRef(0);

  const load = async ({ append = false } = {}) => {
    const generation = ++request.current;
    if (append) setLoadingMore(true);
    else {
      setLoading(true);
      setItems([]);
      setHasMore(false);
      setExpanded(null);
      cursorRef.current = null;
    }
    setError("");
    try {
      const page = await fetchPage({
        kind,
        statusFilter,
        cursor: append ? cursorRef.current : null,
      });
      if (generation !== request.current) return;
      cursorRef.current = page.cursor;
      setHasMore(page.hasMore);
      setItems((current) => {
        const seen = new Set(append ? current.map((item) => item.id) : []);
        const next = append ? [...current] : [];
        for (const item of page.items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          next.push(item);
        }
        return next;
      });
    } catch (err) {
      if (generation === request.current) {
        setError(err.message || variant.error);
      }
    } finally {
      if (generation === request.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  useEffect(() => {
    void load();
    return () => { ++request.current; };
  }, [statusFilter, kind]);

  return (
    <section aria-label={variant.label} className="submission-logs">
      <div className="page-heading">
        <span className="eyebrow">{variant.eyebrow}</span>
        <h2>Submission logs</h2>
        <p>{variant.description}</p>
      </div>

      <div className="submission-log-controls">
        <select
          className="audit-filter-select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          <option value="submitted">Submitted</option>
          <option value="open">Open</option>
          <option value="cancelled">Withdrawn</option>
        </select>
        <button
          type="button"
          className="secondary small"
          onClick={() => load()}
          disabled={loading || loadingMore}
        >
          ↻ Refresh
        </button>
      </div>

      {error && <p className="error-banner" role="alert">{error}</p>}
      {loading && <p role="status">{variant.loading}</p>}
      {!loading && !error && items.length === 0 && (
        <p className="submission-log-empty">{variant.empty}</p>
      )}

      {!loading && items.length > 0 && (
        <div className="audit-list">
          {items.map((item) => {
            const isExpanded = expanded === item.id;
            return (
              <article className="audit-item-card submission-log-card" key={item.id}>
                <div className="audit-card-top">
                  <div className="audit-tag-row">
                    <div className="submission-log-badges">
                      <StatusBadge status={item.status} />
                      <AuditStatusBadge audit={item.audit} />
                    </div>
                    <span className="audit-timestamp">{formatInstant(item.createdAt)}</span>
                  </div>
                </div>

                <div className="audit-card-body">
                  <h3 className="submission-log-title">{item.title || "Untitled"}</h3>

                  <div className="submission-log-meta">
                    <span>
                      <strong>Organisation:</strong> {item.organisation || "—"}
                    </span>
                    <span>
                      <strong>Owner:</strong>{" "}
                      <code>{shortenAddress(item.ownerId)}</code>
                    </span>
                    <span>
                      <strong>{variant.fundingLabel}:</strong>{" "}
                      {formatAmount(item.amount, item.currency)}
                    </span>
                  </div>

                  {kind === "posting" && item.summary && (
                    <p className="submission-log-preview truncated-preview">{item.summary}</p>
                  )}
                  {kind === "funding" && item.fundingThesis && (
                    <p className="submission-log-preview truncated-preview">{item.fundingThesis}</p>
                  )}
                  {kind === "funding" && item.eligibilityNotes && (
                    <p className="submission-log-preview truncated-preview">
                      <strong>Eligibility:</strong> {item.eligibilityNotes}
                    </p>
                  )}

                  <div className="submission-log-meta">
                    {kind === "posting" && item.categories?.length > 0 && (
                      <span>
                        <strong>Categories:</strong>{" "}
                        {item.categories.map(categoryLabel).join(", ")}
                      </span>
                    )}
                    {kind === "funding" && item.tags?.length > 0 && (
                      <span>
                        <strong>Tags:</strong> {item.tags.join(", ")}
                      </span>
                    )}
                    <span>
                      <strong>Attachments:</strong> {item.attachments?.length || 0}
                    </span>
                    <span>
                      <strong>Updated:</strong> {formatInstant(item.updatedAt)}
                    </span>
                  </div>

                  {item.expiresAt && (
                    <p className="submission-log-expiry">
                      <strong>Closes:</strong> {formatInstant(item.expiresAt)}
                    </p>
                  )}
                </div>

                <div className="submission-log-footer">
                  <code className="audit-reference">problems/{item.id}</code>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setExpanded(isExpanded ? null : item.id)}
                  >
                    {isExpanded ? "Hide receipt" : "View receipt"}
                  </button>
                </div>

                {isExpanded && (
                  <AuditReceipt
                    audit={receiptFor(item, variant)}
                    entityLabel={variant.entityLabel}
                    eventLabel={variant.eventLabel}
                    actorRole={variant.actorRole}
                    firebaseReference={`problems/${item.id}`}
                    onVerify={() => variant.readAudit(item)}
                  />
                )}
              </article>
            );
          })}
        </div>
      )}

      {hasMore && !loading && (
        <div className="submission-log-more">
          <button
            type="button"
            className="secondary"
            onClick={() => load({ append: true })}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading more…" : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}

export function PostingSubmissionLogs() {
  return <SubmissionLogs kind="posting" />;
}

export function FundingSubmissionLogs() {
  return <SubmissionLogs kind="funding" />;
}
