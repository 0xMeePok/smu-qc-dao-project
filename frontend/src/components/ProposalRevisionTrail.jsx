import { useEffect, useState } from "react";
import { listProposalRevisions } from "../lib/proposals.js";
import { messageForProposalError } from "../lib/proposalValidation.js";
import { formatInstant } from "../lib/datetime.js";
import { PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS } from "../config/proposal.js";

const FIELD_LABELS = {
  ...Object.fromEntries([...PROPOSAL_FIELDS, ...PROBLEM_FRAMING_FIELDS].map(([key, label]) => [key, label])),
  category: "Category",
  amount: "Requested amount",
  currency: "Currency",
  attachments: "Supporting attachments",
};

function shortWallet(address) {
  const value = String(address ?? "");
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function summary(entry) {
  if (entry.status === "withdrawn" && entry.previousStatus !== "withdrawn") return "Withdrawn from evaluation";
  if (entry.status !== entry.previousStatus) return `Status changed from ${entry.previousStatus} to ${entry.status}`;
  return "Edited after submission";
}

export function ProposalRevisionTrail({ proposalId, field, uid }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError("");
    listProposalRevisions(proposalId, { field, uid })
      .then((records) => { if (!cancelled) setEntries(records); })
      .catch((err) => { if (!cancelled) setError(messageForProposalError(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [proposalId, field, uid]);

  if (loading) return <div className="detail-section"><h2>Edit history</h2><p role="status">Loading edit history…</p></div>;
  if (error) return <div className="detail-section"><h2>Edit history</h2><p className="error-banner" role="alert">{error}</p></div>;
  if (!entries.length) return null;

  return <div className="detail-section">
    <h2>Edit history</h2>
    <p className="field-hint">Every change made after submission. Recorded by the platform, not by the author.</p>
    <ol className="revision-trail">
      {entries.map((entry) => <li key={entry.id}>
        <p><strong>{summary(entry)}</strong> · <time>{formatInstant(entry.at)}</time></p>
        <p className="table-row-meta">By {shortWallet(entry.actor)}</p>
        {entry.changedFields?.length > 0 && <p className="table-row-meta">
          Changed: {entry.changedFields.map((key) => FIELD_LABELS[key] ?? key).join(", ")}
        </p>}
        {entry.withdrawalReason && <p className="proposal-text">Reason: {entry.withdrawalReason}</p>}
      </li>)}
    </ol>
  </div>;
}
