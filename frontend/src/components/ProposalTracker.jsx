import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExpiryCountdown } from "./ExpiryCountdown.jsx";
import { EvaluationBadges, StatusBadge } from "./StatusBadge.jsx";
import { formatInstant } from "../lib/datetime.js";
import { PROPOSAL_STATUS_DRAFT } from "../lib/proposals.js";
import { isModerated } from "../lib/moderation.js";
import { useAuth } from "../context/AuthContext.jsx";
import { recommendationCounts, workflowStatusLabel, INDEPENDENT_FUNDING_STATE as I } from "../config/workflowStatus.js";
import { independentFundingLocked, independentFundingStatus } from "../lib/independentEscrow.js";
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
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("closing");
  // The overview requests this same verified queue. Switching tabs must not
  // discard it and repeat every escrow read; wallet changes use a separate key.
  const queue = useQuery({
    queryKey: ["developerDashboard", user?.id],
    queryFn: listMyProposalQueue,
    enabled: Boolean(user?.id),
    staleTime: 30_000,
    retry: false,
  });
  const rows = useMemo(() => user?.id
    ? (queue.data?.items ?? []).filter((item) => item.status !== PROPOSAL_STATUS_DRAFT)
    : [], [user?.id, queue.data]);
  const summary = user?.id ? queue.data ?? {} : {};
  const loading = Boolean(user?.id) && queue.isPending;
  const error = user?.id && queue.error ? queueError(queue.error) : "";
  const load = () => queue.refetch({ cancelRefetch: false });

  useEffect(() => { setStatus("all"); }, [user?.id]);

  const visible = useMemo(() => sortProposalRows(filterProposalRows(rows, status), sort), [rows, status, sort]);
  const statuses = useMemo(() => statusOptions(rows), [rows]);

  return <div className="card-table proposal-tracker">
    <div className="table-header">
      <h3>My proposals {rows.length > 0 && <span className="count-pill">{rows.length}</span>}</h3>
      <div className="table-header-actions">
        <button className="secondary small" type="button" disabled={queue.isFetching} onClick={load}>Refresh proposals</button>
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
            {!item.grantUnavailable && !item.escrowUnavailable && (independent ? <span className="draft-badge">{independentFundingStatus(item.independentFunding).label}</span> : <StatusBadge status={proposalQueueWorkflowStatus(item)} />)}
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
          {isModerated(item) || item.status === "moderated_removed" || item.status === "moderated_hidden" ? (
            <span aria-label="No time remaining">—</span>
          ) : item.grant?.status === "pending" || item.grant?.status === "expired" ? (
            <span className="table-row-meta">Grant acceptance: <ExpiryCountdown expiresAt={proposalQueueDeadline(item)} showInstant={false} /></span>
          ) : item.escrow ? (proposalQueueDeadline(item) && <span className="table-row-meta">
            {item.escrow.state === "Open" ? "Funding closes" : "Escrow approval"}: <ExpiryCountdown expiresAt={proposalQueueDeadline(item)} showInstant={false} />
          </span>) : item.grantUnavailable || item.escrowUnavailable || ["accepted", "voided"].includes(item.grant?.status) ? null : independent && item.status !== "withdrawn"
            && ![I.RELEASED, I.DECLINED, I.EXPIRED, I.CANCELLED, I.REFUNDED].includes(item.independentFunding?.state) ? (
            <span className="table-row-meta">{item.independentFunding?.state === I.ACCEPTED ? "Completion ends" : "Funding closes"}: <ExpiryCountdown expiresAt={proposalQueueDeadline(item)} status="submitted" showInstant={false} /></span>
          ) : !independent ? (
            <ExpiryCountdown expiresAt={item.posting?.expiresAt} status={item.posting?.status} matching={item.posting?.matching} showInstant={false} />
          ) : null}
          {item.grant?.status === "pending" && item.grant.canAccept && <button className="primary small" type="button" onClick={() => onNavigate(`proposal/${item.id}?tab=funding`)}>Accept grant</button>}
          {(item.escrow || item.escrowUnavailable || item.grant?.status === "accepted") && <button className="text-button" type="button" onClick={() => onNavigate(`proposal/${item.id}?tab=funding`)}>View escrow</button>}
          {independent && <button className="text-button" type="button" onClick={() => onNavigate(`proposal/${item.id}?tab=funding`)}>Open crowdfunding</button>}
          {independent && item.status === "submitted" && !independentFundingLocked(item.independentFunding) && <button className="text-button" type="button" onClick={() => onNavigate(`create-proposal/${item.id}`)}>Edit</button>}
          <button className="text-button" type="button" onClick={() => onNavigate(`proposal/${item.id}`)}>View proposal</button>
        </div>
      </div>; })}
  </div>;
}
