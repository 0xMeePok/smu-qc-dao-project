import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExpiryCountdown } from "./ExpiryCountdown.jsx";
import { EvaluationBadges, StatusBadge } from "./StatusBadge.jsx";
import { formatInstant } from "../lib/datetime.js";
import { PROPOSAL_STATUS_DRAFT } from "../lib/proposals.js";
import { useAuth } from "../context/AuthContext.jsx";
import { recommendationCounts, workflowStatusLabel } from "../config/workflowStatus.js";
import {
  PROPOSAL_SORTS,
  commentCountLabel,
  filterProposalRows,
  isIndependentQueueRow,
  ownerReviewStatus,
  proposalQueueDeadline,
  proposalQueueWorkflowStatus,
  listMyProposalQueue,
  queueError,
  sortProposalRows,
  statusOptions,
} from "../lib/proposalQueues.js";

/** QCDAO-62 - every submitted proposal with where it stands, without asking anyone. */
export function ProposalTracker({ onNavigate }) {
  const { user } = useAuth();
  const generation = useRef(0);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("closing");
  const [summary, setSummary] = useState({});

  const load = useCallback(async () => {
    const request = ++generation.current;
    setRows([]); setSummary({}); setLoading(Boolean(user?.id)); setError("");
    if (!user?.id) return;
    try {
      const data = await listMyProposalQueue();
      if (request !== generation.current) return;
      setRows((data?.items ?? []).filter((item) => item.status !== PROPOSAL_STATUS_DRAFT));
      setSummary({ unavailableGrantOffers: data?.unavailableGrantOffers ?? 0,
        unavailableEscrows: data?.unavailableEscrows ?? 0, truncated: data?.truncated });
    } catch (err) {
      if (request === generation.current) setError(queueError(err));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    setStatus("all");
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  const visible = useMemo(() => sortProposalRows(filterProposalRows(rows, status), sort), [rows, status, sort]);
  const statuses = useMemo(() => statusOptions(rows), [rows]);

  return <div className="card-table proposal-tracker">
    <div className="table-header">
      <h3>My proposals {rows.length > 0 && <span className="count-pill">{rows.length}</span>}</h3>
      <div className="table-header-actions">
        <button className="secondary small" type="button" disabled={loading} onClick={load}>Refresh proposals</button>
        <button className="secondary small" type="button" onClick={() => onNavigate("discover")}>Browse opportunities</button>
        <button className="primary small" type="button" onClick={() => onNavigate("create-proposal")}>Publish independent proposal</button>
      </div>
    </div>
    {rows.length > 0 && <div className="table-toolbar">
      <label className="table-filter">Status
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">All statuses</option>
          {statuses.map((value) => <option key={value} value={value}>{workflowStatusLabel(value)}</option>)}
        </select>
      </label>
      <label className="table-filter">Sort
        <select value={sort} onChange={(event) => setSort(event.target.value)}>
          {PROPOSAL_SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
    </div>}
    {!loading && !error && summary.unavailableGrantOffers > 0 && <p className="field-hint" role="status">{summary.unavailableGrantOffers} grant offer records could not be verified. Open the grant funding panel or retry for their current status.</p>}
    {!loading && !error && summary.unavailableEscrows > 0 && <p className="field-hint" role="status">{summary.unavailableEscrows} escrow records could not be verified. Open proposal funding or retry for their current status.</p>}
    {!loading && !error && summary.truncated && <p className="field-hint">Showing a limited set of proposals. Open individual opportunities for the remaining records.</p>}
    {loading ? <p className="table-empty" role="status">Loading proposals…</p>
      : error ? <p className="error-banner" role="alert">{error}</p>
      : !visible.length ? <p className="table-empty">{rows.length > 0 ? "No proposals match this status." : summary.unavailableGrantOffers > 0 || summary.unavailableEscrows > 0
        ? "Verified proposal records are temporarily unavailable. Refresh to retry." : summary.truncated
          ? "No proposals are shown in this limited result. Open individual opportunities to check the remaining records."
          : "No proposals yet. Respond to an open opportunity, or publish an independent listing."}</p>
      : visible.map((item) => { const review = ownerReviewStatus(item.ownerReview); const independent = isIndependentQueueRow(item); return <div className="table-row" key={item.id}>
        <div>
          {/* The bold line is this member's own proposal; the opportunity it answers
              is named beneath it, so neither title can be mistaken for the other. */}
          <strong>{item.title || "Untitled proposal"}</strong>
          <small className="table-row-meta">
            {independent ? "Independent listing" : `Proposal for: ${item.posting?.title || "Untitled opportunity"}`}
          </small>
          <span className="status-badges">
            {!item.grantUnavailable && !item.escrowUnavailable && <StatusBadge status={proposalQueueWorkflowStatus(item)} />}
            {!independent && <EvaluationBadges counts={recommendationCounts(item.recommendations ?? [])} />}
            {review && <StatusBadge status={review.status} prefix="Owner · " />}
          </span>
          <small className="table-row-meta">
            Submitted {formatInstant(item.createdAt)} · {commentCountLabel(item)}{review?.note ? ` · ${review.note}` : ""}
          </small>
          {item.grantUnavailable && <small className="table-row-meta">Grant offer status is temporarily unavailable.</small>}
          {item.escrowUnavailable && <small className="table-row-meta">Escrow status is temporarily unavailable.</small>}
        </div>
        <div className="table-row-actions">
          {item.grant?.status === "pending" || item.grant?.status === "expired" ? (
            <span className="table-row-meta">Grant acceptance: <ExpiryCountdown expiresAt={proposalQueueDeadline(item)} showInstant={false} /></span>
          ) : item.escrow ? (proposalQueueDeadline(item) && <span className="table-row-meta">
            {item.escrow.state === "Open" ? "Funding closes" : "Escrow approval"}: <ExpiryCountdown expiresAt={proposalQueueDeadline(item)} showInstant={false} />
          </span>) : item.grantUnavailable || item.escrowUnavailable || ["accepted", "voided"].includes(item.grant?.status) ? null : independent && item.status !== "withdrawn" ? (
            <ExpiryCountdown expiresAt={item.expiresAt ?? item.posting?.expiresAt} status="submitted" showInstant={false} />
          ) : !independent ? (
            <ExpiryCountdown expiresAt={item.posting?.expiresAt} status={item.posting?.status} matching={item.posting?.matching} showInstant={false} />
          ) : null}
          {item.grant?.status === "pending" && item.grant.canAccept && <button className="primary small" type="button" onClick={() => onNavigate(`proposal/${item.id}?tab=funding`)}>Accept grant</button>}
          {(item.escrow || item.escrowUnavailable || item.grant?.status === "accepted") && <button className="text-button" type="button" onClick={() => onNavigate(`proposal/${item.id}?tab=funding`)}>View escrow</button>}
          {independent && item.status === "submitted" && <button className="text-button" type="button" onClick={() => onNavigate(`create-proposal/${item.id}`)}>Edit</button>}
          <button className="text-button" type="button" onClick={() => onNavigate(`proposal/${item.id}`)}>View proposal</button>
        </div>
      </div>; })}
  </div>;
}
