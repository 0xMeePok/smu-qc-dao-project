import { useEffect, useRef, useState } from "react";
import { formatInstant } from "../lib/datetime.js";

const STATUS_COPY = {
  queued: "Queued for wallet submission",
  submitted: "Submitted to Arbitrum Sepolia",
  pending: "Waiting for block confirmation",
  confirmed: "Transaction confirmation recorded",
  failed: "Posting saved; verification needs attention",
  checking: "Reading AuditRegistry",
  verified: "Verified on Arbitrum Sepolia",
  mismatch: "On-chain mismatch",
  unavailable: "Audit unavailable",
};

function CopyValue({ label, value }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  if (!value) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  };

  return (
    <div className="audit-receipt-value">
      <dt>{label}</dt>
      <dd><code>{value}</code></dd>
      <button className="text-button" type="button" onClick={copy}>
        {copied ? "Copied" : `Copy ${label.toLowerCase()}`}
      </button>
      {copyError && <span role="status">Copy unavailable. Select and copy the value above.</span>}
    </div>
  );
}

function verificationState(result) {
  if (typeof result?.verified !== "boolean") {
    return { kind: "unavailable", message: "Unable to verify — no verification result was returned. Try again." };
  }
  return result?.verified
    ? {
      kind: "match",
      message: "Verified match — the current record matches the configured AuditRegistry.",
      result,
    }
    : {
      kind: "mismatch",
      message: "Mismatch detected — the current record differs from the configured AuditRegistry.",
      result,
    };
}

function unavailableState(error, audit) {
  const missing = /invalidinput|revert/i.test(error?.message ?? "");
  return {
    kind: "unavailable",
    message: missing && ["submitted", "pending"].includes(audit?.status)
      ? "Unable to verify yet — the transaction is waiting for confirmation. Your submission is saved."
      : missing
      ? "No matching audit was found on the configured AuditRegistry."
      : (error?.message || "Unable to read the configured AuditRegistry."),
  };
}

/** Human-readable view of the verification overlay required by QCDAO-77/78. */
export function AuditReceipt({
  audit,
  eventLabel,
  actorRole,
  firebaseReference,
  onVerify,
  onRetry,
  entityLabel = "Posting",
}) {
  const [verification, setVerification] = useState(null);
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);
  const verifyRef = useRef(onVerify);
  verifyRef.current = onVerify;
  const canVerify = Boolean(onVerify);
  // Firestore is not the source of truth for audit state. Always read the
  // configured registry when a record can be verified.
  const shouldVerifyAutomatically = canVerify && Boolean(audit?.transactionHash || audit?.status === "confirmed");

  const check = async (verify) => {
    const request = ++generation.current;
    setChecking(true);
    try {
      const result = await verify();
      if (request === generation.current) setVerification(verificationState(result));
    } catch (error) {
      if (request === generation.current) setVerification(unavailableState(error, audit));
    } finally {
      if (request === generation.current) setChecking(false);
    }
  };

  useEffect(() => {
    ++generation.current;
    if (!shouldVerifyAutomatically) {
      setVerification(null);
      setChecking(false);
      return undefined;
    }
    let active = true;
    setVerification(null);
    setChecking(true);
    Promise.resolve().then(() => verifyRef.current())
      .then((result) => {
        if (!active) return;
        setVerification(verificationState(result));
      })
      .catch((error) => {
        if (!active) return;
        setVerification(unavailableState(error, audit));
      })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; ++generation.current; };
  }, [audit?.entityId, audit?.contentHash, audit?.solutionHash, audit?.transactionHash, audit?.status, shouldVerifyAutomatically]);

  if (!audit) {
    return (
      <section className="audit-receipt audit-unavailable" aria-label="Audit receipt">
        <h2>On-chain verification</h2>
        <p>
          This record remains available in the workflow. Its verification receipt is
          unavailable or uses an unsupported format.
        </p>
      </section>
    );
  }

  const verify = async () => {
    if (!onVerify) return;
    await check(onVerify);
  };

  const displayStatus = checking
    ? "checking"
    : verification?.kind === "match"
      ? "verified"
      : verification?.kind === "mismatch"
        ? "mismatch"
        : verification?.kind === "unavailable"
          ? ["queued", "submitted", "pending", "failed"].includes(audit.status) ? audit.status : "unavailable"
          : audit.status;
  const chainAnchor = verification?.result?.anchor?.anchor;
  const chainTimestamp = chainAnchor?.timestamp ?? chainAnchor?.[5];
  const chainActor = chainAnchor?.actor ?? chainAnchor?.[4];

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
        <span className={`audit-state audit-state-${displayStatus}`}>
          {displayStatus === "failed" ? `${entityLabel} saved; verification needs attention` : STATUS_COPY[displayStatus] || displayStatus}
        </span>
      </div>

      <p className="field-hint">
        The business record stays usable independently of this verification state.
        The receipt proves which version was anchored without putting its contents on-chain.
      </p>

      <dl className="audit-receipt-grid">
        <div><dt>Event</dt><dd>{eventLabel}</dd></div>
        <div><dt>On-chain timestamp</dt><dd>{chainTimestamp
          ? formatInstant(new Date(Number(chainTimestamp) * 1000))
          : "Not available"}</dd></div>
        <div><dt>Actor role</dt><dd>{actorRole}</dd></div>
        <div><dt>On-chain actor</dt><dd>{chainActor ? <code>{chainActor}</code> : "Not available"}</dd></div>
        <div><dt>Firebase reference</dt><dd><code>{firebaseReference}</code></dd></div>
        <div><dt>Canonical format</dt><dd>Version {audit.schemaVersion}</dd></div>
        <div><dt>Receipt block</dt><dd>{audit.blockNumber || "Not confirmed"}</dd></div>
        <CopyValue label="Verification hash" value={audit.contentHash} />
        <CopyValue label="Solution hash" value={audit.solutionHash} />
        <CopyValue label="Transaction reference" value={audit.transactionHash} />
      </dl>

      {audit.lastError && <p className="audit-warning" role="alert">{audit.lastError}</p>}
      {verification && (
        <p className={`audit-verification audit-verification-${verification.kind}`} role={verification.kind === "mismatch" ? "alert" : "status"}>
          {verification.message}
        </p>
      )}

      <div className="form-actions">
        {onVerify && (
          <button className="secondary" type="button" onClick={verify} disabled={checking}>
            {checking ? "Checking…" : "Check again"}
          </button>
        )}
        {onRetry && (audit.transactionHash || audit.attemptCount < 3) && ["queued", "submitted", "pending", "failed"].includes(audit.status) && (
          <button className="secondary" type="button" onClick={onRetry}>
            {audit.transactionHash ? "Resume verification" : audit.status === "queued" ? "Start verification" : "Retry anchoring"}
          </button>
        )}
        {explorerUrl && (
          <a className="text-button audit-explorer-link" href={explorerUrl} target="_blank" rel="noreferrer">
            View transaction on Arbiscan
          </a>
        )}
      </div>
      {!audit.transactionHash && audit.attemptCount >= 3 && <p role="status">Wallet retry limit reached. Ask an administrator to reset verification attempts. Your submission is still saved.</p>}
    </section>
  );
}
