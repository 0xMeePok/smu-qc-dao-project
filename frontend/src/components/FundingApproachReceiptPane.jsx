import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext.jsx";
import { formatInstant } from "../lib/datetime.js";
import { fundingApproachError, getFundingApproach } from "../lib/fundingApproach.js";
import { AuditDetailPane } from "./AuditDetailPane.jsx";

function anchored(status, transactionHash) {
  return status === "confirmed" && Boolean(transactionHash);
}

function AnchorReceipt({ title, status, anchorId, recordHash, transactionHash, anchoredAt, pendingCopy }) {
  const confirmed = anchored(status, transactionHash);
  const explorer = confirmed ? `https://sepolia.arbiscan.io/tx/${transactionHash}` : null;
  return (
    <section className="audit-receipt" aria-label={title}>
      <div className="audit-receipt-heading">
        <div>
          <span className="eyebrow">Audit receipt</span>
          <h2>{title}</h2>
        </div>
        <span className={`audit-state audit-state-${confirmed ? "confirmed" : "pending"}`}>
          {confirmed ? "Anchored on Arbitrum Sepolia" : "Not on-chain yet"}
        </span>
      </div>
      <p className="field-hint">
        {confirmed
          ? "This hash is on the escrow audit registry. The message stays off-chain."
          : pendingCopy}
      </p>
      <dl className="audit-receipt-grid">
        <div><dt>Anchor id</dt><dd><code>{anchorId || "Not available"}</code></dd></div>
        <div><dt>Record hash</dt><dd><code>{recordHash || "Not available"}</code></dd></div>
        <div><dt>Transaction</dt><dd>{explorer ? <a href={explorer} target="_blank" rel="noreferrer">{transactionHash}</a> : "Not on-chain yet"}</dd></div>
        {anchoredAt ? <div><dt>Anchored</dt><dd>{formatInstant(anchoredAt)}</dd></div> : null}
      </dl>
    </section>
  );
}

/** Stored approach hash, and the decision hash once one exists. Not the proposal submission receipt. */
export function FundingApproachReceiptPane({ approachId, record = null, onClose }) {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ["fundingApproach", approachId, user?.id],
    queryFn: () => getFundingApproach(approachId),
    enabled: Boolean(approachId) && !record,
  });
  const item = record || query.data;
  const error = query.error ? fundingApproachError(query.error, "The audit receipt could not be loaded. Try again.") : "";
  const hasDecision = Boolean(item?.decisionAnchorId || item?.decisionAnchorStatus || item?.decisionRecordHash);
  return (
    <AuditDetailPane title={item?.proposalTitle || "Funding approach audit receipt"} onClose={onClose}>
      {!record && query.isPending && <p role="status">Loading audit receipt…</p>}
      {!record && error && <p className="error-banner" role="alert">{error}</p>}
      {item && (
        <>
          <AnchorReceipt
            title="Funding approach"
            status={item.anchorStatus}
            anchorId={item.approachAnchorId}
            recordHash={item.recordHash}
            transactionHash={item.transactionHash}
            anchoredAt={item.anchoredAt}
            pendingCopy="This approach is not on-chain yet."
          />
          {hasDecision && (
            <AnchorReceipt
              title="Funding approach decision"
              status={item.decisionAnchorStatus}
              anchorId={item.decisionAnchorId}
              recordHash={item.decisionRecordHash}
              transactionHash={item.decisionTransactionHash}
              anchoredAt={item.decisionAnchoredAt}
              pendingCopy="This decision is not on-chain yet."
            />
          )}
        </>
      )}
    </AuditDetailPane>
  );
}
