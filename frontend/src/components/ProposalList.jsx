import { messageForProposalError } from "../lib/proposalValidation.js";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { PROPOSAL_STATUS_DRAFT, deleteProposalDraft, listProposals } from "../lib/proposals.js";
import { formatInstant } from "../lib/datetime.js";
import { Modal } from "./Modal.jsx";

function Row({ item, onNavigate, onDelete }) {
  const isDraft = item.status === PROPOSAL_STATUS_DRAFT;
  return <div className="table-row">
    <div>
      <strong>{item.title || "Untitled draft"}</strong>
      <small className="table-row-meta">
        {isDraft
          ? `Last saved ${formatInstant(item.updatedAt)}`
          : `${item.status} · ${item.currency} ${Number(item.amount).toLocaleString()} · ${formatInstant(item.createdAt)}`}
      </small>
    </div>
    <div className="table-row-actions">
      {isDraft && <span className="draft-badge">Draft</span>}
      <button className="text-button" type="button" onClick={() => onNavigate(isDraft ? `edit-proposal/${item.id}` : `proposal/${item.id}`)}>
        {isDraft ? "Resume editing" : "View proposal"}
      </button>
      {isDraft && <button className="text-button danger-text" type="button" onClick={() => onDelete(item)}>Delete</button>}
    </div>
  </div>;
}

export function ProposalList({ received = false, onNavigate }) {
  const { user } = useAuth();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      setData(await listProposals(received ? "postingOwnerId" : "researcherId", user.id));
    } catch (err) {
      setError(messageForProposalError(err));
    } finally {
      setLoading(false);
    }
  }, [received, user.id]);

  useEffect(() => { load(); }, [load]);

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await deleteProposalDraft(pendingDelete);
      setPendingDelete(null);
      await load();
    } catch (err) { setError(messageForProposalError(err)); }
    finally { setDeleting(false); }
  };

  const drafts = data.filter((item) => item.status === PROPOSAL_STATUS_DRAFT);
  const submitted = data.filter((item) => item.status !== PROPOSAL_STATUS_DRAFT);

  return <>
    {!received && <div className="card-table">
      <div className="table-header"><h3>Drafts {drafts.length > 0 && <span className="count-pill">{drafts.length}</span>}</h3></div>
      {loading ? <p className="table-empty" role="status">Loading drafts…</p>
        : drafts.length === 0 ? <p className="table-empty">No drafts. Save an unfinished proposal to come back to it.</p>
        : drafts.map((item) => <Row key={item.id} item={item} onNavigate={onNavigate} onDelete={setPendingDelete} />)}
    </div>}

    <div className="card-table">
      <div className="table-header"><h3>{received ? "Proposals received" : "My proposals"}</h3>{!received && <button className="secondary small" onClick={() => onNavigate("discover")}>Browse opportunities</button>}</div>
      {loading ? <p className="table-empty" role="status">Loading proposals…</p>
        : error ? <p className="error-banner" role="alert">{error}</p>
        : !submitted.length ? <p className="table-empty">{received ? "No proposals received yet." : "No proposals yet. Choose an open opportunity to submit your approach."}</p>
        : submitted.map((item) => <Row key={item.id} item={item} onNavigate={onNavigate} onDelete={setPendingDelete} />)}
    </div>

    {pendingDelete && <Modal labelledBy="delete-proposal-draft-title" describedBy="delete-proposal-draft-desc" onDismiss={() => { if (!deleting) setPendingDelete(null); }}>
      <div className="modal-head"><div>
        <h2 id="delete-proposal-draft-title">Delete this draft?</h2>
        <p id="delete-proposal-draft-desc"><strong>{pendingDelete.title || "Untitled draft"}</strong> and any files attached to it will be permanently removed. This cannot be undone.</p>
      </div></div>
      <div className="modal-actions">
        <button className="secondary" type="button" disabled={deleting} onClick={() => setPendingDelete(null)}>Keep it</button>
        <button className="danger-btn" type="button" disabled={deleting} onClick={confirmDelete}>{deleting ? "Deleting…" : "Delete draft"}</button>
      </div>
    </Modal>}
  </>;
}
