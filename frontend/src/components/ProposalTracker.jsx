import { useCallback, useEffect, useMemo, useState } from "react";
import { ExpiryCountdown } from "./ExpiryCountdown.jsx";
import { formatInstant } from "../lib/datetime.js";
import { MATCHING_LABELS } from "../lib/matching.js";
import { PROPOSAL_STATUS_DRAFT } from "../lib/proposals.js";
import {
  PROPOSAL_SORTS,
  commentCountLabel,
  feedbackLabel,
  filterProposalRows,
  ownerReviewTrackerLabel,
  listMyProposalQueue,
  queueError,
  sortProposalRows,
  statusOptions,
} from "../lib/proposalQueues.js";

function sentenceCase(value) {
  const text = String(value ?? "").replaceAll("_", " ");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

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
      {rows.length > 0 && <div className="table-header-controls">
        <label className="comment-sort">Status
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All statuses</option>
            {statuses.map((value) => <option key={value} value={value}>{MATCHING_LABELS[value] || sentenceCase(value)}</option>)}
          </select>
        </label>
        <label className="comment-sort">Sort by
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            {PROPOSAL_SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>}
    </div>
    {loading ? <p className="table-empty" role="status">Loading proposals…</p>
      : error ? <p className="error-banner" role="alert">{error}</p>
      : !visible.length ? <p className="table-empty">No proposals yet. Choose an open opportunity to submit your approach.</p>
      : visible.map((item) => <div className="table-row" key={item.id}>
        <div>
          {/* The bold line is this member's own proposal; the opportunity it answers
              is named beneath it, so neither title can be mistaken for the other. */}
          <strong>{item.title || "Untitled proposal"}</strong>
          <small className="table-row-meta">
            Proposal for: {item.posting?.title || "Untitled opportunity"}
          </small>
          <small className="table-row-meta">
            Status: {MATCHING_LABELS[item.matchingStatus] || sentenceCase(item.status)} · Submitted {formatInstant(item.createdAt)}
          </small>
          <small className="table-row-meta">
            {feedbackLabel(item)} · {commentCountLabel(item)}
          </small>
          {ownerReviewTrackerLabel(item.ownerReview) && <small className="table-row-meta">{ownerReviewTrackerLabel(item.ownerReview)}</small>}
        </div>
        <div className="table-row-actions">
          <ExpiryCountdown expiresAt={item.posting?.expiresAt} status={item.posting?.status} matching={item.posting?.matching} showInstant={false} />
          <button className="text-button" type="button" onClick={() => onNavigate(`proposal/${item.id}`)}>View proposal</button>
        </div>
      </div>)}
  </div>;
}
