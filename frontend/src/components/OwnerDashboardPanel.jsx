import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { DashboardAttention, DashboardCount } from "./DashboardAttention.jsx";
import { EvaluationBadges, StatusBadge } from "./StatusBadge.jsx";
import { ExpiryCountdown } from "./ExpiryCountdown.jsx";
import { useActionItems } from "../lib/actionItems.js";
import { ownerAttention } from "../lib/dashboardAttention.js";
import { OWNER_DASHBOARD_KEY, listOwnerDashboard, queueError } from "../lib/proposalQueues.js";
import { useAuth } from "../context/AuthContext.jsx";
import { formatInstant } from "../lib/datetime.js";
import { workflowStatusLabel } from "../config/workflowStatus.js";

/**
 * QCDAO-92 - one screen answering "where does my work stand".
 *
 * Grouped by the question each number answers rather than by the collection it
 * came from. The readiness line on every posting is the point of the screen: an
 * owner cannot begin a selection until a solution has reached its funding
 * target, and that condition lives on the solution, not on the posting, so
 * until now it could only be found by opening each one.
 *
 * Deliberately a roll-up and not a replacement for the tables beneath it. The
 * drafts and published lists already manage individual postings; this says
 * which of them needs looking at first.
 */

const money = (currency, amount) => `${currency || ""} ${Number(amount || 0)
  .toLocaleString(undefined, { maximumFractionDigits: 2 })}`.trim();

function Stat({ label, value, hint, tone }) {
  return (
    <div className={`stat-card${tone ? ` stat-card-${tone}` : ""}`}>
      <h3 className="stat-label">{label}</h3>
      <strong className="stat-num">{value}</strong>
      {hint && <p className="stat-hint">{hint}</p>}
    </div>
  );
}

/** Whether selection can begin, and if not, what is holding it shut. */
function Readiness({ posting }) {
  if (posting.isDraft) {
    return <p className="queue-note">Not published yet. Nothing can be submitted against a draft.</p>;
  }
  if (posting.opportunityType === "open-funding") {
    return (
      <p className="queue-note">
        Grant funding is held in this opportunity&apos;s on-chain pool. Open grant funding for the deposited balance and its offers.
      </p>
    );
  }
  if (posting.readiness.canSelect) {
    return (
      <p className="queue-note queue-note-ready">
        Selection can begin: {posting.fundedSolutions} fully funded{" "}
        {posting.fundedSolutions === 1 ? "solution" : "solutions"} with evaluator feedback on file.
      </p>
    );
  }
  if (!posting.readiness.blockers.length) {
    return <p className="queue-note">No decision is outstanding on this posting.</p>;
  }
  return (
    <ul className="rollup-blockers">
      {posting.readiness.blockers.map((blocker) => (
        <li key={blocker.kind} className="queue-note queue-note-gate">{blocker.detail}</li>
      ))}
    </ul>
  );
}

function PostingRollup({ posting, onNavigate }) {
  const open = posting.live && !posting.isDraft;
  const link = (tab, label) => (
    <button type="button" className="text-button" onClick={() => onNavigate?.(`posting/${posting.id}?tab=${tab}`)}>{label}</button>
  );
  return (
    <article className="rollup-card">
      <div className="rollup-head">
        <div>
          <strong>{posting.title || "Untitled posting"}</strong>
          <span className="status-badges">
            <StatusBadge status={posting.workflowStatus} />
            {posting.qualifyingRecommendations > 0 && <EvaluationBadges counts={posting.recommendationOutcomes} />}
          </span>
          {open && <ExpiryCountdown expiresAt={posting.expiresAt} status={posting.status} />}
        </div>
        <div className="table-row-actions">
          {link("proposals", "Solutions & comparison")}
          {link("funding", posting.opportunityType === "open-funding" ? "Grant funding" : "Selection & funding")}
          {link("record", "Audit record")}
        </div>
      </div>

      <dl className="rollup-stats">
        <div><dt>Solutions received</dt><dd>{posting.proposalsReceived}</dd></div>
        <div><dt>Still open</dt><dd>{posting.openSolutions}</dd></div>
        <div><dt>Fully funded</dt><dd>{posting.fundedSolutions}</dd></div>
        <div><dt>Recommendations</dt><dd>{posting.qualifyingRecommendations}</dd></div>
        <div><dt>Awaiting feedback</dt><dd>{posting.awaitingFeedback}</dd></div>
      </dl>

      {posting.fundingTarget > 0 && (
        <div className="rollup-meter">
          <progress
            aria-label={`Funding committed across open solutions on ${posting.title || "this posting"}`}
            value={posting.fundingCommitted}
            max={posting.fundingTarget}
          />
          <small>
            {money(posting.currency, posting.fundingCommitted)} committed of{" "}
            {money(posting.currency, posting.fundingTarget)} asked across open solutions · {posting.fundingPercent}%
            {" · "}Posting requirement {money(posting.currency, posting.requestedAmount)}
          </small>
        </div>
      )}

      <Readiness posting={posting} />

      {posting.recommendations.length > 0 && (
        <div className="rollup-recommendations">
          <h4>Evaluator recommendations</h4>
          {/* Each badge is the outcome, and the link opens the comment that
              carries it. The evaluator's reasoning is the part an owner needs;
              the count on its own decides nothing. */}
          <ul>
            {posting.recommendations.map((item) => (
              <li key={item.commentId}>
                <StatusBadge status={item.recommendation} prefix="Evaluator · " interactive={false} />
                <button
                  type="button"
                  className="record-jump"
                  onClick={() => onNavigate?.(`proposal/${item.proposalId}?comment=${item.commentId}`)}
                >
                  {item.proposalTitle || "Untitled solution"}
                </button>
                {item.at && <small className="table-row-meta">{formatInstant(item.at)}</small>}
              </li>
            ))}
          </ul>
          {posting.qualifyingRecommendations > posting.recommendations.length && (
            <p className="queue-note">
              {posting.qualifyingRecommendations - posting.recommendations.length} more on this posting.
              {" "}{link("proposals", "Open every solution")}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

export function OwnerDashboardPanel({ onNavigate }) {
  const { user } = useAuth();
  const dashboard = useQuery({
    queryKey: [...OWNER_DASHBOARD_KEY, user?.id],
    queryFn: listOwnerDashboard,
    enabled: Boolean(user?.id),
    staleTime: 30_000,
  });
  const actions = useActionItems();
  const data = dashboard.data;

  const postingIds = useMemo(
    () => new Set((data?.postings ?? []).map((posting) => posting.id)),
    [data?.postings],
  );
  const attention = useMemo(() => ownerAttention(actions.data, postingIds), [actions.data, postingIds]);

  const error = dashboard.error ? queueError(dashboard.error) : "";
  const totals = data?.totals;
  // Drafts are managed on the postings tab; a draft has no activity to roll up.
  const published = (data?.postings ?? []).filter((posting) => !posting.isDraft);

  return (
    <section className="role-dashboard-panel" aria-label="Posting overview">
      <div className="audit-trail-heading">
        <h2>Posting overview</h2>
        <p>
          Every posting you own with the solutions, funding and evaluator feedback on it, counted from live
          records. Readiness is the funding condition a selection depends on, not an opinion about which
          solution to pick.
        </p>
      </div>

      <DashboardCount
        loading={dashboard.isPending}
        error={error}
        generatedAt={data?.generatedAt}
        suffix={attention.length > 0 ? ` · ${attention.length} ${attention.length === 1 ? "item needs" : "items need"} you` : ""}
      />

      {error && <p className="error-banner" role="alert">{error}</p>}
      {!dashboard.isPending && (
        <button type="button" className="secondary small" disabled={dashboard.isFetching} onClick={() => dashboard.refetch()}>
          {dashboard.isFetching ? "Refreshing…" : "Refresh overview"}
        </button>
      )}
      {!dashboard.isPending && !error && (data?.truncated?.postings || data?.truncated?.proposals) && (
        <p className="field-hint" role="status">
          Counted from the most recent records only. The real totals are higher.
        </p>
      )}

      <DashboardAttention
        items={attention}
        blockers={data?.blockers ?? []}
        loading={actions.isPending}
        error={actions.error ? queueError(actions.error) : ""}
        onNavigate={onNavigate}
        emptyMessage="Nothing is blocked on you right now."
      />

      {!dashboard.isPending && !error && totals && (
        <>
          <div className="dashboard-stats-grid admin-activity-grid">
            <Stat label="Live postings" value={totals.live} hint={`${totals.postings} in total, including ${totals.drafts} ${totals.drafts === 1 ? "draft" : "drafts"}`} />
            <Stat label="Solutions received" value={totals.proposalsReceived} />
            <Stat
              label="Postings ready to select"
              value={totals.readyToSelect}
              hint={totals.readyToSelect > 0 ? "Fully funded with evaluator feedback on file." : "No posting has a selectable solution yet."}
            />
            <Stat
              label="Solutions awaiting feedback"
              value={totals.awaitingFeedback}
              tone={totals.awaitingFeedback > 0 ? "warn" : undefined}
              hint={totals.awaitingFeedback > 0 ? "No evaluator has recommended these yet." : "Every open solution has a recommendation."}
            />
            <Stat label="Accepted solutions" value={totals.acceptedSolutions} />
          </div>

          {data.accepted.length > 0 && (
            <div className="card-table">
              <div className="table-header"><h3>Accepted solutions <span className="count-pill">{data.accepted.length}</span></h3></div>
              {data.accepted.map((item) => (
                <div className="table-row" key={item.proposalId}>
                  <div>
                    <strong>{item.title || "Untitled solution"}</strong>
                    <small className="table-row-meta">On: {item.postingTitle || "Untitled posting"}</small>
                    <small className="table-row-meta">
                      {money(item.currency, item.amount)}
                      {item.escrowBacked ? " · Escrow-backed" : ""}
                      {item.acceptedAt ? ` · Accepted ${formatInstant(item.acceptedAt)}` : ""}
                    </small>
                  </div>
                  <div className="table-row-actions">
                    <button type="button" className="text-button" onClick={() => onNavigate?.(`proposal/${item.proposalId}?tab=funding`)}>Funding</button>
                    <button type="button" className="text-button" onClick={() => onNavigate?.(`proposal/${item.proposalId}?tab=record`)}>Audit record</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {published.length === 0 ? (
            <div className="audit-trail-empty">
              <h3>{totals.drafts > 0 ? "Nothing published yet" : "No postings yet"}</h3>
              <p>
                {totals.drafts > 0
                  ? "Your drafts are below. Publish one and this overview starts tracking the solutions, funding and evaluator feedback on it."
                  : "Post a research challenge and this overview tracks the solutions it attracts, how close each is to its funding target, and the evaluator feedback a decision needs."}
              </p>
              <button type="button" className="primary small" onClick={() => onNavigate?.("create")}>+ New brief</button>
            </div>
          ) : (
            <div className="rollup-list">
              {published.map((posting) => <PostingRollup key={posting.id} posting={posting} onNavigate={onNavigate} />)}
            </div>
          )}

          {totals.closed > 0 && (
            <p className="field-hint">
              {totals.closed} of these {totals.closed === 1 ? "posting is" : "postings are"} closed
              ({workflowStatusLabel("decision_recorded")}, {workflowStatusLabel("expired")} or {workflowStatusLabel("invalidated")}) and take no further decisions.
            </p>
          )}
        </>
      )}
    </section>
  );
}
