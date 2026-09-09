import { useEffect, useState } from "react";
import { formatInstant } from "../lib/datetime.js";
import { listProposalsForPosting, PROPOSAL_STATUS_DRAFT } from "../lib/proposals.js";
import { messageForProposalError } from "../lib/proposalValidation.js";

function proposalStatusLabel(status) {
  return String(status ?? "")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function Row({ item, onNavigate }) {
  const isDraft = item.status === PROPOSAL_STATUS_DRAFT;
  return (
    <div className="table-row">
      <div>
        <strong>{item.title || "Untitled draft"}</strong>
        <small className="table-row-meta">
          {isDraft
            ? `Last saved ${formatInstant(item.updatedAt)}`
            : `${proposalStatusLabel(item.status)} · ${item.currency} ${Number(item.amount).toLocaleString()} · ${formatInstant(item.createdAt)}`}
        </small>
      </div>
      <div className="table-row-actions">
        {isDraft ? <span className="draft-badge">Draft</span> : null}
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
      postingOwnerId: posting.ownerId,
    })
      .then((found) => { if (!cancelled) setItems(found); })
      .catch((err) => { if (!cancelled) { setItems([]); setError(messageForProposalError(err)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [posting?.id, posting?.ownerId, viewerId]);

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
          {items.map((item) => <Row key={item.id} item={item} onNavigate={onNavigate} />)}
        </div>
      ) : (
        <p className="table-empty">
          {isPoster
            ? "No proposals received yet."
            : "Proposals are visible to the poster and to each author."}
        </p>
      )}
    </div>
  );
}
