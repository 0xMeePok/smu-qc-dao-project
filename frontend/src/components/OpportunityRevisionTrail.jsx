import { useEffect, useState } from "react";
import { listOpportunityRevisions } from "../lib/postings.js";
import { messageForFirebaseError } from "../lib/errors.js";
import { formatInstant } from "../lib/datetime.js";

const FIELD_LABELS = {
  title: "Title",
  summary: "Problem description",
  businessContext: "Business context",
  currentApproach: "Current approach",
  currentLimitations: "Limitations of that approach",
  expectedOutcome: "Expected outcome",
  successCriteria: "Success criteria",
  dataAvailability: "Data availability",
  fundingThesis: "Funding thesis",
  eligibilityNotes: "Eligibility notes",
  categories: "Technology areas",
  tags: "Tags",
  amount: "Funding amount",
  currency: "Currency",
  expiresAt: "Closing date",
  attachments: "Supporting documents",
};

function shortWallet(address) {
  const value = String(address ?? "");
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function summary(entry) {
  if (entry.status === "cancelled" && entry.previousStatus !== "cancelled") return "Withdrawn from the marketplace";
  if (entry.status !== entry.previousStatus) return `Status changed from ${entry.previousStatus} to ${entry.status}`;
  return "Edited after submission";
}

export function OpportunityRevisionTrail({ postingId, uid, isOwner = false }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError("");
    listOpportunityRevisions(postingId, { uid, isOwner })
      .then((records) => { if (!cancelled) setEntries(records); })
      .catch((err) => { if (!cancelled) setError(messageForFirebaseError(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [postingId, uid, isOwner]);

  if (loading) return <div className="detail-section"><h2>Edit history</h2><p role="status">Loading edit history…</p></div>;
  if (error) return <div className="detail-section"><h2>Edit history</h2><p className="error-banner" role="alert">{error}</p></div>;
  if (!entries.length) return null;

  return (
    <div className="detail-section">
      <h2>Edit history</h2>
      <p className="field-hint">Every change made after publication. Recorded by the platform, not by the owner.</p>
      <ol className="revision-trail">
        {entries.map((entry) => (
          <li key={entry.id}>
            <p><strong>{summary(entry)}</strong> · <time>{formatInstant(entry.at)}</time></p>
            <p className="table-row-meta">By {shortWallet(entry.actor)}</p>
            {entry.changedFields?.length > 0 && (
              <p className="table-row-meta">
                Changed: {entry.changedFields.map((key) => FIELD_LABELS[key] ?? key).join(", ")}
              </p>
            )}
            {entry.withdrawalReason && <p className="proposal-text">Reason: {entry.withdrawalReason}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
