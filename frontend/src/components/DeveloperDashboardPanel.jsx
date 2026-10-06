import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { DashboardAttention, DashboardCount } from "./DashboardAttention.jsx";
import { EvaluationBadges, StatusBadge } from "./StatusBadge.jsx";
import { FundingApproachList } from "./FundingApproachList.jsx";
import { useActionItems } from "../lib/actionItems.js";
import { fundingApproachError, listFundingApproaches } from "../lib/fundingApproach.js";
import { developerAttention } from "../lib/dashboardAttention.js";
import {
  isIndependentQueueRow, listMyProposalQueue, proposalQueueWorkflowStatus, queueError,
} from "../lib/proposalQueues.js";
import { discussionCountLabel } from "../lib/dashboardAttention.js";
import { PROPOSAL_STATUS_DRAFT } from "../lib/proposals.js";
import { useAuth } from "../context/AuthContext.jsx";
import { formatInstant } from "../lib/datetime.js";
import { WORKFLOW_STATUS, recommendationCounts, workflowStatusLabel } from "../config/workflowStatus.js";

/**
 * QCDAO-93 - every submission this member has made, and what is happening to it.
 *
 * Grouped by what the author is waiting for rather than by status string, so
 * "nobody has looked at this yet" and "three evaluators have" are not two rows
 * of the same colour. Evaluator feedback links to the comments that carry it:
 * the reasoning is the useful part, and no metric, score, weighting or ranking
 * is shown, because none exists for an author to see.
 *
 * A roll-up, not a replacement for the tracker beneath it. The tracker lists
 * every submission with its filters; this says which ones need reading first.
 */

const OPEN_RECORD = new Set(["submitted", "under_review"]);
const ACCEPTED = new Set([WORKFLOW_STATUS.ACCEPTED, WORKFLOW_STATUS.COMPLETED]);

function Stat({ label, value, hint, tone }) {
  return (
    <div className={`stat-card${tone ? ` stat-card-${tone}` : ""}`}>
      <h3 className="stat-label">{label}</h3>
      <strong className="stat-num">{value}</strong>
      {hint && <p className="stat-hint">{hint}</p>}
    </div>
  );
}

function Group({ title, hint, rows, children }) {
  if (!rows.length) return null;
  return (
    <div className="card-table">
      <div className="table-header"><h3>{title} <span className="count-pill">{rows.length}</span></h3></div>
      {hint && <p className="field-hint action-group-hint">{hint}</p>}
      {rows.map(children)}
    </div>
  );
}

function RowShell({ row, onNavigate, children, meta }) {
  const independent = isIndependentQueueRow(row);
  return (
    <div className="table-row" key={row.id}>
      <div>
        <strong>{row.title || "Untitled solution"}</strong>
        <small className="table-row-meta">
          {independent ? "Independent listing" : `Solution for: ${row.posting?.title || "Untitled opportunity"}`}
        </small>
        <span className="status-badges">
          <StatusBadge status={proposalQueueWorkflowStatus(row)} />
          {!independent && row.qualifying > 0 && <EvaluationBadges counts={recommendationCounts(row.recommendations ?? [])} />}
        </span>
        {/* The discussion count excludes the recommendations listed beneath it,
            so a busy thread is never mistaken for a pile of evaluator filings. */}
        <small className="table-row-meta">
          Submitted {formatInstant(row.createdAt)} · {discussionCountLabel(row)}
        </small>
        {meta}
      </div>
      <div className="table-row-actions">
        {children}
        <button type="button" className="text-button" onClick={() => onNavigate?.(`proposal/${row.id}`)}>Open discussion</button>
        <button type="button" className="text-button" onClick={() => onNavigate?.(`proposal/${row.id}?tab=record`)}>Audit record</button>
      </div>
    </div>
  );
}

/** The recommendation comments on one solution, each linked to its own words. */
function RecommendationLinks({ row, onNavigate }) {
  if (!row.recommendationComments?.length) return null;
  return (
    <div className="rollup-recommendations">
      <ul>
        {row.recommendationComments.map((item) => (
          <li key={item.commentId}>
            <StatusBadge status={item.recommendation} prefix="Evaluator · " interactive={false} />
            <button
              type="button"
              className="record-jump"
              onClick={() => onNavigate?.(`proposal/${row.id}?comment=${item.commentId}`)}
            >
              Read the recommendation
            </button>
            {item.at && <small className="table-row-meta">{formatInstant(item.at)}</small>}
          </li>
        ))}
      </ul>
      {row.qualifying > row.recommendationComments.length && (
        <p className="queue-note">{row.qualifying - row.recommendationComments.length} more on this solution.</p>
      )}
    </div>
  );
}

export function DeveloperDashboardPanel({ onNavigate }) {
  const { user } = useAuth();
  const queue = useQuery({
    queryKey: ["developerDashboard", user?.id],
    queryFn: listMyProposalQueue,
    enabled: Boolean(user?.id),
    staleTime: 30_000,
  });
  const approaches = useQuery({
    queryKey: ["fundingApproaches", user?.id],
    queryFn: listFundingApproaches,
    enabled: Boolean(user?.id),
    staleTime: 30_000,
  });
  const actions = useActionItems();
  const rows = queue.data?.items ?? [];

  const proposalIds = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const attention = useMemo(() => developerAttention(actions.data, proposalIds), [actions.data, proposalIds]);

  const groups = useMemo(() => {
    const submitted = rows.filter((row) => row.status !== PROPOSAL_STATUS_DRAFT);
    const open = submitted.filter((row) => OPEN_RECORD.has(row.status));
    return {
      drafts: rows.filter((row) => row.status === PROPOSAL_STATUS_DRAFT),
      submitted,
      awaitingFeedback: open.filter((row) => !isIndependentQueueRow(row) && (row.qualifying ?? 0) === 0),
      reviewed: open.filter((row) => (row.qualifying ?? 0) > 0),
      accepted: submitted.filter((row) => ACCEPTED.has(proposalQueueWorkflowStatus(row))),
      independent: submitted.filter((row) => isIndependentQueueRow(row)),
      // Every visible comment that is not a qualifying recommendation: the
      // ordinary discussion on a solution, kept apart so a question from the
      // owner is never mistaken for an evaluator's filing.
      discussion: submitted.reduce((total, row) => total + Math.max(0, (row.comments ?? 0) - (row.qualifying ?? 0)), 0),
      recommendations: submitted.reduce((total, row) => total + (row.qualifying ?? 0), 0),
    };
  }, [rows]);

  const error = queue.error ? queueError(queue.error) : "";

  return (
    <section className="role-dashboard-panel" aria-label="Submission overview">
      <div className="audit-trail-heading">
        <h2>Submission overview</h2>
        <p>
          Every solution you have submitted and what is happening to it. Evaluator feedback links to the
          recommendation comments themselves; no scores, weightings or rankings exist for an author to see.
        </p>
      </div>

      <DashboardCount
        loading={queue.isPending}
        error={error}
        generatedAt={queue.dataUpdatedAt ? new Date(queue.dataUpdatedAt).toISOString() : null}
        suffix={attention.length > 0 ? ` · ${attention.length} ${attention.length === 1 ? "item needs" : "items need"} you` : ""}
      />

      {error && <p className="error-banner" role="alert">{error}</p>}
      {!queue.isPending && (
        <button type="button" className="secondary small" disabled={queue.isFetching || approaches.isFetching} onClick={() => { queue.refetch(); approaches.refetch(); }}>
          {queue.isFetching || approaches.isFetching ? "Refreshing…" : "Refresh overview"}
        </button>
      )}
      {!queue.isPending && !error && queue.data?.truncated && (
        <p className="field-hint" role="status">Counted from a limited set of records. The real totals are higher.</p>
      )}

      <DashboardAttention
        items={attention}
        loading={actions.isPending}
        error={actions.error ? queueError(actions.error) : ""}
        onNavigate={onNavigate}
        emptyMessage="Nothing is blocked on you right now."
      />

      <FundingApproachList
        heading="h3"
        title="Funding approaches received"
        hint="Indicative interest from a client or funder. Accept or decline a pending approach. This does not deposit tokens."
        empty="No funding approaches yet."
        items={approaches.data?.incoming ?? []}
        truncated={approaches.data?.truncated?.incoming}
        loading={approaches.isPending}
        error={approaches.error ? fundingApproachError(approaches.error, "Funding approaches could not be loaded. Please try again.") : ""}
        onNavigate={onNavigate}
        onUpdated={() => approaches.refetch()}
        showFunder
      />

      {!queue.isPending && !error && (
        <>
          <div className="dashboard-stats-grid admin-activity-grid">
            <Stat label="Solutions submitted" value={groups.submitted.length} hint={`${groups.drafts.length} ${groups.drafts.length === 1 ? "draft" : "drafts"} saved below`} />
            <Stat
              label="Solutions awaiting feedback"
              value={groups.awaitingFeedback.length}
              tone={groups.awaitingFeedback.length > 0 ? "warn" : undefined}
              hint={groups.awaitingFeedback.length > 0 ? "No evaluator has filed a recommendation on these yet." : "Every open solution has feedback."}
            />
            <Stat label="Recommendations received" value={groups.recommendations} hint="Visible, Evaluator-badged comments carrying an outcome." />
            <Stat label={workflowStatusLabel(WORKFLOW_STATUS.ACCEPTED)} value={groups.accepted.length} />
            <Stat label="Discussion comments" value={groups.discussion} hint="Everything that is not an evaluator recommendation." />
          </div>

          {groups.submitted.length === 0 ? (
            <div className="audit-trail-empty">
              <h3>{groups.drafts.length > 0 ? "Nothing submitted yet" : "No solutions yet"}</h3>
              <p>
                {groups.drafts.length > 0
                  ? "Your drafts are below. Submit one and this overview tracks its evaluator feedback, selection and acceptance."
                  : "Answer an open opportunity, or publish an independent listing. This overview then tracks every submission through feedback, selection and acceptance."}
              </p>
              <button type="button" className="primary small" onClick={() => onNavigate?.("discover")}>Browse opportunities</button>
            </div>
          ) : (
            <>
              <Group
                title={workflowStatusLabel(WORKFLOW_STATUS.AWAITING_EVALUATOR_FEEDBACK)}
                hint="No evaluator has filed a recommendation yet. Recommendations are advisory: an owner can select without one."
                rows={groups.awaitingFeedback}
              >
                {(row) => <RowShell key={row.id} row={row} onNavigate={onNavigate} />}
              </Group>

              <Group
                title="Evaluator feedback received"
                hint="Visible comments carrying the Evaluator badge and one of the three outcomes. Open one to read the reasoning behind it."
                rows={groups.reviewed}
              >
                {(row) => (
                  <RowShell key={row.id} row={row} onNavigate={onNavigate}
                    meta={<RecommendationLinks row={row} onNavigate={onNavigate} />} />
                )}
              </Group>

              <Group
                title="Accepted solutions"
                hint="Both parties approved the match. Escrow-backed work shows its payment state on the funding screen."
                rows={groups.accepted}
              >
                {(row) => (
                  <RowShell key={row.id} row={row} onNavigate={onNavigate}
                    meta={row.escrowUnavailable
                      ? <small className="table-row-meta">Escrow status is temporarily unavailable.</small>
                      : row.escrow
                        ? <small className="table-row-meta">Escrow: {row.escrow.state}</small>
                        : null}>
                    {(row.escrow || row.escrowUnavailable || row.grant?.status === "accepted") && (
                      <button type="button" className="text-button" onClick={() => onNavigate?.(`proposal/${row.id}?tab=funding`)}>Escrow</button>
                    )}
                  </RowShell>
                )}
              </Group>

              <Group
                title="Independent listings"
                hint="Published by you without a parent opportunity, so no evaluator gate applies. Every one is listed here, including any that also appear above."
                rows={groups.independent}
              >
                {(row) => (
                  <RowShell key={row.id} row={row} onNavigate={onNavigate}
                    meta={row.acceptedApproachId ? <small className="table-row-meta">A funding approach has been accepted.</small> : null} />
                )}
              </Group>
            </>
          )}
        </>
      )}
    </section>
  );
}
