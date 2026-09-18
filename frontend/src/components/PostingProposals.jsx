import { useEffect, useState } from "react";
import { formatInstant } from "../lib/datetime.js";
import { listProposalsForPosting, PROPOSAL_STATUS_DRAFT } from "../lib/proposals.js";
import { messageForProposalError } from "../lib/proposalValidation.js";
import { proposalFundingLabel } from "../lib/matching.js";
import { VerifiedBadge } from "./VerifiedBadge.jsx";

function Row({ item, onNavigate, problemMatching }) {
  const isDraft = item.status === PROPOSAL_STATUS_DRAFT;
  return (
    <div className="table-row">
      <div>
        <strong>{item.title || "Untitled draft"}</strong>
        <small className="table-row-meta">
          {isDraft
            ? `Last saved ${formatInstant(item.updatedAt)}`
            : `${proposalFundingLabel(item, problemMatching)} · ${item.currency} ${Number(item.amount).toLocaleString()} · ${formatInstant(item.createdAt)}`}
        </small>
      </div>
      <div className="table-row-actions">
        {isDraft ? <span className="draft-badge">Draft</span> : null}
        <VerifiedBadge audit={item.audit} recordStatus={item.status} />
        <button
          className="text-button"
          type="button"
          onClick={() => onNavigate(isDraft ? `edit-proposal/${item.id}` : `proposal/${item.id}`)}
        >
          {isDraft ? "Resume editing" : "View proposal"}
        </button>
      </div>
    </div>
  );
}

export function PostingProposals({ posting, viewerId, isPoster, proposalCount, onNavigate }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(Boolean(viewerId));
  const [error, setError] = useState("");

  useEffect(() => {
    if (!viewerId || !posting?.id) {
      setItems([]);
      setLoading(false);
      setError("");
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    listProposalsForPosting({
      problemId: posting.id,
      viewerId,
    })
      .then((found) => { if (!cancelled) setItems(found); })
      .catch((err) => { if (!cancelled) { setItems([]); setError(messageForProposalError(err)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [posting?.id, posting?.matching?.status, posting?.matching?.proposalId, viewerId]);

  const countLabel = `${proposalCount} ${proposalCount === 1 ? "proposal" : "proposals"} received`;

  return (
    <div className="detail-section">
      <h2>Proposals</h2>
      <p>{countLabel}.</p>
      {loading ? (
        <p className="table-empty" role="status">Loading proposals…</p>
      ) : error ? (
        <p className="error-banner" role="alert">{error}</p>
      ) : items.length > 0 ? (
        <div className="card-table posting-proposals">
          {items.map((item) => <Row key={item.id} item={item} onNavigate={onNavigate} problemMatching={posting.matching} />)}
        </div>
      ) : (
        <p className="table-empty">
          {isPoster
            ? "No proposals received yet."
            : "No submitted proposals on this opportunity yet."}
        </p>
      )}
    </div>
  );
}
