import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { formatInstant } from "../lib/datetime.js";
import { listProposalsForPosting, PROPOSAL_STATUS_DRAFT } from "../lib/proposals.js";
import { messageForProposalError } from "../lib/proposalValidation.js";
import { claimRemovedProposalFunds, escrowErrorMessage } from "../lib/escrow.js";
import { moderationReasonLabel } from "../lib/moderation.js";
import { AUDIT_REGISTRY_CHAIN_ID } from "../config/auditRegistry.js";
import { useAuth } from "../context/AuthContext.jsx";
import { FundingMeta } from "./FundingMeta.jsx";
import { VerifiedBadge } from "./VerifiedBadge.jsx";
import { StatusBadge } from "./StatusBadge.jsx";
import { ConnectWalletModal } from "./ConnectWalletModal.jsx";
import { WORKFLOW_STATUS } from "../config/workflowStatus.js";

const reasonLabel = moderationReasonLabel;

function RemovedProposalRow({ item }) {
  const { user } = useAuth();
  const { address, isConnected, chainId } = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connect, setConnect] = useState(false);
  const ready = isConnected && address?.toLowerCase() === user?.id?.toLowerCase() && chainId === AUDIT_REGISTRY_CHAIN_ID;
  const claim = async () => {
    if (!ready) { setConnect(true); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      await claimRemovedProposalFunds({ proposalId: item.id, account: address });
      setNotice("Refund claimed. The tokens are in the wallet that deposited them.");
    } catch (err) {
      setError(escrowErrorMessage(err));
    } finally { setBusy(false); }
  };
  return (
    <div className="table-row removed-proposal">
      <div>
        <strong>{item.title || "Untitled proposal"}</strong>
        <small className="table-row-meta">Removed due to: {reasonLabel(item.reason)}{item.details ? ` — ${item.details}` : ""}</small>
        {error && <p role="alert" className="field-hint">{error}</p>}
        {notice && <p role="status" className="field-hint">{notice}</p>}
      </div>
      {item.claimFunds && <div className="table-row-actions">
        <button className="secondary" type="button" disabled={busy} onClick={claim}>{busy ? "Claiming…" : "Claim funds"}</button>
      </div>}
      {connect && <ConnectWalletModal onClose={() => setConnect(false)} />}
    </div>
  );
}

function Row({ item, onNavigate, problemMatching }) {
  if (item.removed) return <RemovedProposalRow item={item} />;
  const isDraft = item.status === PROPOSAL_STATUS_DRAFT;
  return (
    <div className="table-row">
      <div>
        <strong>{item.title || "Untitled draft"}</strong>
        <small className="table-row-meta">
          {isDraft
            ? `Last saved ${formatInstant(item.updatedAt)}`
            : <FundingMeta item={item} problemMatching={problemMatching} />}
        </small>
      </div>
      <div className="table-row-actions">
        {isDraft && <StatusBadge status={WORKFLOW_STATUS.DRAFT} />}
        <VerifiedBadge audit={item.audit} recordStatus={item.status} hidePending />
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
      {!posting?.removed && <p>{countLabel}.</p>}
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
          {posting?.removed
            ? "No funded proposals are waiting for a refund."
            : isPoster
              ? "No proposals received yet."
              : "No submitted proposals on this opportunity yet."}
        </p>
      )}
    </div>
  );
}
