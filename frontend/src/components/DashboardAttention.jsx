import { ExpiryCountdown } from "./ExpiryCountdown.jsx";
import { StatusBadge } from "./StatusBadge.jsx";
import { formatInstant } from "../lib/datetime.js";
import { BLOCKER_LABELS } from "../lib/dashboardAttention.js";

/**
 * QCDAO-92/93 - what is blocked on this member, worst deadline first.
 *
 * Two lists, deliberately not merged. The first is work this member can finish
 * now. The second is why a record is stuck on someone else: a funding target
 * nobody has met, an evaluator who has not filed. Mixing them would read as a
 * to-do list containing items the member cannot do anything about.
 */

export function DashboardAttention({
  items = [], blockers = [], loading = false, error = "", onNavigate, onOpenReceipt,
  emptyMessage = "Nothing needs your attention right now.",
}) {
  return (
    <section className="dashboard-attention" aria-label="Needs my attention">
      <div className="admin-activity-group-head">
        <div>
          <h3>Needs my attention</h3>
          <p>Ordered by what lapses soonest. A missed approval window invalidates the posting and refunds its funders.</p>
        </div>
      </div>

      {error && <p className="error-banner" role="alert">{error}</p>}
      {loading && <p className="table-empty" role="status">Loading your actions…</p>}

      {!loading && !error && (
        <ol className="dashboard-attention-list">
          {items.length === 0 && <li className="table-empty">{emptyMessage}</li>}
          {items.map((item) => (
            <li key={item.key} className={`dashboard-attention-item${item.dual ? " is-dual" : ""}`}>
              <div>
                <span className="dashboard-attention-heading">
                  {item.heading}
                  {/* Named, because a dual approval is the one step where doing
                      nothing costs the other party their funding too. */}
                  {item.dual && <span className="dashboard-attention-tag">Dual approval</span>}
                </span>
                <strong>{item.title}</strong>
                {item.postingTitle && <small className="table-row-meta">On: {item.postingTitle}</small>}
                {item.workflowStatus && <StatusBadge status={item.workflowStatus} />}
                <p className="queue-note">{item.note}</p>
              </div>
              <div className="table-row-actions">
                {item.deadlineAt && (
                  <span className="table-row-meta">
                    Ends <ExpiryCountdown expiresAt={item.deadlineAt} showInstant={false} />
                  </span>
                )}
                <button type="button" className="primary small" onClick={() => onNavigate?.(item.route)}>{item.cta}</button>
                {item.kind === "funding-approach" && (
                  <button type="button" className="text-button" onClick={() => onOpenReceipt?.(item.id)}>Audit receipt</button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {blockers.length > 0 && (
        <div className="dashboard-blockers">
          <h4>Waiting on someone else</h4>
          <p className="queue-note">Nothing here is yours to fix. It is listed so a stalled posting is never a mystery.</p>
          <ul>
            {blockers.map((blocker) => (
              <li key={`${blocker.postingId}-${blocker.kind}`} className="queue-note queue-note-gate">
                <strong>{BLOCKER_LABELS[blocker.kind] ?? "Blocked"}</strong> · {blocker.postingTitle || "Untitled posting"} — {blocker.detail}
                {onNavigate && (
                  <button type="button" className="text-button" onClick={() => onNavigate(`posting/${blocker.postingId}?tab=proposals`)}>
                    Open posting
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** The "counted at" line both dashboards carry, matching the audit trail's. */
export function DashboardCount({ loading, error, generatedAt, suffix = "" }) {
  return (
    <p className="audit-trail-count" role="status" aria-live="polite">
      {loading ? "Loading dashboard…"
        : error ? "Dashboard unavailable"
        : `Counted ${formatInstant(generatedAt)}`}
      {!loading && !error ? suffix : ""}
    </p>
  );
}
