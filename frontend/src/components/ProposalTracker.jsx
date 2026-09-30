import { useCallback, useEffect, useMemo, useState } from "react";
import { ExpiryCountdown } from "./ExpiryCountdown.jsx";
import { EvaluationBadges, StatusBadge } from "./StatusBadge.jsx";
import { formatInstant } from "../lib/datetime.js";
import { PROPOSAL_STATUS_DRAFT } from "../lib/proposals.js";
import { recommendationCounts, workflowStatusLabel } from "../config/workflowStatus.js";
import {
  PROPOSAL_SORTS,
  commentCountLabel,
  filterProposalRows,
  isIndependentQueueRow,
  ownerReviewStatus,
  listMyProposalQueue,
  queueError,
  sortProposalRows,
  statusOptions,
} from "../lib/proposalQueues.js";

/** QCDAO-62 - every submitted proposal with where it stands, without asking anyone. */
export function ProposalTracker({ onNavigate }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("closing");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const data = await listMyProposalQueue();
      setRows((data?.items ?? []).filter((item) => item.status !== PROPOSAL_STATUS_DRAFT));
    } catch (err) {
      setError(queueError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => sortProposalRows(filterProposalRows(rows, status), sort), [rows, status, sort]);
  const statuses = useMemo(() => statusOptions(rows), [rows]);

  return <div className="card-table">
    <div className="table-header">
      <h3>My proposals {rows.length > 0 && <span className="count-pill">{rows.length}</span>}</h3>
      <div className="table-header-controls">
        {rows.length > 0 && <>
        <label className="comment-sort">Status
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All statuses</option>
            {statuses.map((value) => <option key={value} value={value}>{workflowStatusLabel(value)}</option>)}
          </select>
        </label>
        <label className="comment-sort">Sort by
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            {PROPOSAL_SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        </>}
        <button className="secondary small" type="button" onClick={() => onNavigate("discover")}>Browse opportunities</button>
        <button className="primary small" type="button" onClick={() => onNavigate("create-proposal")}>Publish independent proposal</button>
      </div>
    </div>
    {loading ? <p className="table-empty" role="status">Loading proposals…</p>
      : error ? <p className="error-banner" role="alert">{error}</p>
      : !visible.length ? <p className="table-empty">No proposals yet. Respond to an open opportunity, or publish an independent listing.</p>
      : visible.map((item) => { const review = ownerReviewStatus(item.ownerReview); const independent = isIndependentQueueRow(item); return <div className="table-row" key={item.id}>
        <div>
          {/* The bold line is this member's own proposal; the opportunity it answers
              is named beneath it, so neither title can be mistaken for the other. */}
          <strong>{item.title || "Untitled proposal"}</strong>
          <small className="table-row-meta">
            {independent ? "Independent listing" : `Proposal for: ${item.posting?.title || "Untitled opportunity"}`}
          </small>
          <span className="status-badges">
            <StatusBadge status={item.workflowStatus} />
            {!independent && <EvaluationBadges counts={recommendationCounts(item.recommendations ?? [])} />}
            {review && <StatusBadge status={review.status} prefix="Owner · " />}
          </span>
          <small className="table-row-meta">
            Submitted {formatInstant(item.createdAt)} · {commentCountLabel(item)}{review?.note ? ` · ${review.note}` : ""}
          </small>
        </div>
        <div className="table-row-actions">
          {independent && item.status !== "withdrawn" ? (
            <ExpiryCountdown expiresAt={item.expiresAt ?? item.posting?.expiresAt} status="submitted" showInstant={false} />
          ) : !independent ? (
            <ExpiryCountdown expiresAt={item.posting?.expiresAt} status={item.posting?.status} matching={item.posting?.matching} showInstant={false} />
          ) : null}
          <button className="text-button" type="button" onClick={() => onNavigate(`proposal/${item.id}`)}>View proposal</button>
        </div>
      </div>; })}
  </div>;
}
