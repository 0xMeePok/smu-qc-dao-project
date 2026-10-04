import { useCallback, useEffect, useState } from "react";
import { fetchAdminActivity, formatBaseUnits } from "../lib/adminActivity.js";
import { messageForFirebaseError } from "../lib/errors.js";
import { formatInstant } from "../lib/datetime.js";
import { roleLabel } from "../lib/roles.js";

/**
 * QCDAO-140 - one screen answering "what is on the platform right now".
 *
 * Grouped by the question each number answers rather than by the collection it
 * came from: who is here, what is moving, what is blocked, what needs an
 * administrator. A flat wall of counts reads as a database dump, and the
 * administrator is the one role with no workspace of their own to interpret it.
 */

const ROLE_ORDER = [["user", 0], ["evaluator", 2], ["administrator", 1]];

function Stat({ label, value, hint, tone }) {
  return (
    <div className={`stat-card${tone ? ` stat-card-${tone}` : ""}`}>
      <h3 className="stat-label">{label}</h3>
      <strong className="stat-num">{value}</strong>
      {hint && <p className="stat-hint">{hint}</p>}
    </div>
  );
}

function Group({ title, description, truncated, children, action }) {
  return (
    <section className="admin-activity-group">
      <div className="admin-activity-group-head">
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
        {action}
      </div>
      <div className="dashboard-stats-grid admin-activity-grid">{children}</div>
      {truncated && (
        <p className="field-hint" role="status">
          Counted from the most recent records only. The real total is higher.
        </p>
      )}
    </section>
  );
}

export function AdminActivityPanel({ onOpenTab }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await fetchAdminActivity());
    } catch (err) {
      setError(messageForFirebaseError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const link = (tab, label) => (
    <button type="button" className="secondary small" onClick={() => onOpenTab?.(tab)}>{label}</button>
  );

  const needsAttention = (data?.moderation?.pending ?? 0) + (data?.anchoring?.failed ?? 0);

  return (
    <section className="admin-activity-panel" aria-label="Platform activity">
      <div className="audit-trail-heading">
        <h2>Platform activity</h2>
        <p>
          What is on the platform right now, counted from live records. This is separate from
          Platform Status, which reports whether the services behind it are healthy.
        </p>
      </div>

      <p className="audit-trail-count" role="status" aria-live="polite">
        {loading ? "Loading platform activity…"
          : error ? "Platform activity unavailable"
          : `Counted ${formatInstant(data?.generatedAt)}`}
        {!loading && !error && needsAttention > 0
          ? ` · ${needsAttention} ${needsAttention === 1 ? "item needs" : "items need"} an administrator`
          : ""}
      </p>

      {error && <p className="error-banner" role="alert">{error}</p>}
      {!loading && (
        <button type="button" className="secondary small" onClick={load}>Refresh</button>
      )}

      {!loading && !error && data && (
        <>
          <Group
            title="Needs an administrator"
            description="Work that stays queued until someone acts on it."
            action={link("moderation", "Open moderation queue")}
          >
            <Stat
              label="Reports awaiting moderation"
              value={data.moderation.pending}
              tone={data.moderation.pending > 0 ? "alert" : undefined}
              hint={data.moderation.pending > 0 ? "Content stays visible until a decision is recorded." : "Nothing is waiting."}
            />
            <Stat
              label="Failed anchoring transactions"
              value={data.anchoring.failed}
              tone={data.anchoring.failed > 0 ? "alert" : undefined}
              hint={data.anchoring.failed > 0 ? "These records are saved but unverified on-chain." : "Every queued anchor has settled."}
            />
          </Group>

          <Group
            title="People"
            description="Access levels, not stakeholder roles. Every account starts as a platform user; evaluator and administrator are granted here."
            truncated={data.truncated?.users}
            action={link("users", "Open user management")}
          >
            {ROLE_ORDER.map(([key, level]) => (
              <Stat key={key} label={roleLabel(level)} value={data.users.byRole[key] ?? 0} />
            ))}
            <Stat
              label="Suspended accounts"
              value={data.users.suspended}
              tone={data.users.suspended > 0 ? "warn" : undefined}
            />
          </Group>

          <Group
            title="Marketplace"
            description="Live postings and the solutions filed against them."
            truncated={data.truncated?.postings || data.truncated?.proposals}
          >
            <Stat label="Active postings" value={data.postings.active} hint={`${data.postings.total} in total, including closed and draft`} />
            <Stat label="Open proposals" value={data.proposals.open} hint={`${data.proposals.total} in total`} />
            <Stat label="Selections in progress" value={data.proposals.selectionsInProgress} hint="Picked by an owner, not yet accepted." />
          </Group>

          <Group
            title="Evaluator feedback"
            description="A qualifying recommendation is a visible, Evaluator-badged comment carrying one of the three outcomes."
            truncated={data.truncated?.comments}
          >
            <Stat label="Qualifying recommendations" value={data.evaluatorFeedback.qualifyingComments} />
            <Stat
              label="Postings with feedback outstanding"
              value={data.postings.feedbackGatesOutstanding}
              tone={data.postings.feedbackGatesOutstanding > 0 ? "warn" : undefined}
              hint={data.postings.feedbackGatesOutstanding > 0
                ? "An owner cannot take these to a decision yet."
                : "Every live posting has the feedback it needs."}
            />
          </Group>

          <Group
            title="Escrow"
            description="On-chain funding targets are exact token base units and are shown unconverted."
            truncated={data.truncated?.proposals}
          >
            <Stat label="Escrow-backed proposals" value={data.escrow.backedProposals} />
            <Stat label="Escrow target (base units)" value={formatBaseUnits(data.escrow.targetBaseUnits)} />
            <Stat label="Mock funding committed" value={data.escrow.mockFunded.toLocaleString()} />
          </Group>
        </>
      )}
    </section>
  );
}
