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
      message: "Mismatch detected — this submission does not match the version recorded in the smart contract on Arbitrum Sepolia. Its integrity cannot be verified. Contact the submission owner or an administrator to review the difference.",
      result,
    };
}

function unavailableState(error, audit) {
  const code = String(error?.code ?? "");
  const detail = String(error?.message ?? "");
  let message = "Unable to verify right now — the latest submission or smart contract could not be read. Check your connection and select Check again. No match or mismatch has been established.";
  if (/permission-denied|unauthenticated/.test(code)) {
    message = "Unable to verify — you do not currently have access to this submission. Sign in with an authorised account and try again.";
  } else if (/no longer available/.test(detail)) {
    message = "Unable to verify — this submission is no longer available or you no longer have access. Refresh the page or contact an administrator.";
  } else if (/not configured/.test(detail)) {
    message = "Verification is unavailable because the verification service is not configured. Contact an administrator.";
  } else if (/hash scheme.*supported|unsupported.*schema/i.test(detail)) {
    message = "Unable to verify — this submission uses an unsupported verification format. Contact an administrator.";
  } else if (/invalidinput/i.test(detail)) {
    message = ["submitted", "pending"].includes(audit?.status)
      ? "No matching audit was found yet — the transaction may still be waiting for confirmation. Wait a moment and select Check again."
      : "No matching audit was found in the smart contract on Arbitrum Sepolia. The submission is not verified. Contact the submission owner or an administrator.";
  }
  return { kind: "unavailable", message };
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
    setVerification(null);
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
    const request = ++generation.current;
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
        if (!active || request !== generation.current) return;
        setVerification(verificationState(result));
      })
      .catch((error) => {
        if (!active || request !== generation.current) return;
        setVerification(unavailableState(error, audit));
      })
      .finally(() => { if (active && request === generation.current) setChecking(false); });
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
        <CopyValue label="Verification hash" value={verification?.result?.expected?.contentHash ?? audit.contentHash} />
        <CopyValue label="Solution hash" value={verification?.result?.expected?.solutionHash ?? audit.solutionHash} />
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
