import { useState } from "react";
import { formatInstant } from "../lib/datetime.js";

const STATUS_COPY = {
  queued: "Queued for wallet submission",
  submitted: "Submitted to Arbitrum Sepolia",
  pending: "Waiting for block confirmation",
  confirmed: "Verified on Arbitrum Sepolia",
  failed: "Posting saved; verification needs attention",
};

function CopyValue({ label, value }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="audit-receipt-value">
      <dt>{label}</dt>
      <dd><code>{value}</code></dd>
      <button className="text-button" type="button" onClick={copy}>
        {copied ? "Copied" : `Copy ${label.toLowerCase()}`}
      </button>
    </div>
  );
}

/** Human-readable view of the verification overlay required by QCDAO-77/78. */
export function AuditReceipt({
  audit,
  eventLabel,
  timestamp,
  actorRole,
  firebaseReference,
  onVerify,
  onRetry,
}) {
  const [verification, setVerification] = useState(null);
  const [checking, setChecking] = useState(false);

  if (!audit) {
    return (
      <section className="audit-receipt audit-unavailable" aria-label="Audit receipt">
        <h2>On-chain verification</h2>
        <p>
          This record is available in the workflow, but no AuditRegistry deployment is
          configured for this environment.
        </p>
      </section>
    );
  }

  const verify = async () => {
    if (!onVerify) return;
    setChecking(true);
    try {
      const result = await onVerify();
      setVerification(result?.verified
        ? { kind: "match", message: "Verified match — the current record matches the on-chain hash." }
        : { kind: "mismatch", message: "Mismatch detected — this record no longer matches the value anchored on-chain." });
    } catch (error) {
      setVerification({
        kind: "unavailable",
        message: error?.message || "Unable to verify while the network is unavailable.",
      });
    } finally {
      setChecking(false);
    }
  };

  const explorerUrl = audit.transactionHash
    ? `https://sepolia.arbiscan.io/tx/${audit.transactionHash}`
    : null;

  return (
    <section className="audit-receipt" aria-label="Audit receipt">
      <div className="audit-receipt-heading">
        <div>
          <span className="eyebrow">Audit receipt</span>
          <h2>{eventLabel}</h2>
        </div>
        <span className={`audit-state audit-state-${audit.status}`}>
          {STATUS_COPY[audit.status] || audit.status}
        </span>
      </div>

      <p className="field-hint">
        The business record stays usable independently of this verification state.
        The receipt proves which version was anchored without putting its contents on-chain.
      </p>

      <dl className="audit-receipt-grid">
        <div><dt>Event</dt><dd>{eventLabel}</dd></div>
        <div><dt>Timestamp</dt><dd>{formatInstant(timestamp)}</dd></div>
        <div><dt>Actor role</dt><dd>{actorRole}</dd></div>
        <div><dt>Firebase reference</dt><dd><code>{firebaseReference}</code></dd></div>
        <div><dt>Canonical format</dt><dd>Version {audit.schemaVersion}</dd></div>
        <div><dt>Block</dt><dd>{audit.blockNumber || "Not confirmed"}</dd></div>
        <CopyValue label="Verification hash" value={audit.contentHash} />
        <CopyValue label="Transaction reference" value={audit.transactionHash} />
      </dl>

      {audit.lastError && <p className="audit-warning" role="alert">{audit.lastError}</p>}
      {verification && (
        <p className={`audit-verification audit-verification-${verification.kind}`} role="status">
          {verification.message}
        </p>
      )}

      <div className="form-actions">
        {audit.status === "confirmed" && onVerify && (
          <button className="secondary" type="button" onClick={verify} disabled={checking}>
            {checking ? "Re-verifying…" : "Re-verify current record"}
          </button>
        )}
        {audit.status === "failed" && onRetry && audit.attemptCount < 3 && (
          <button className="secondary" type="button" onClick={onRetry}>Retry anchoring</button>
        )}
        {explorerUrl && (
          <a className="text-button audit-explorer-link" href={explorerUrl} target="_blank" rel="noreferrer">
            View transaction on Arbiscan
          </a>
        )}
      </div>
    </section>
  );
}
