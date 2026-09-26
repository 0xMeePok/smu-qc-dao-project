import { useEffect, useRef, useState } from "react";
import { VERIFIED_STATES, verifiedStateFromAudit } from "../config/verifiedBadge.js";
import { VerifiedBadge } from "./VerifiedBadge.jsx";

// Admin tables can contain a full page of records. Limit simultaneous chain
// checks so opening a page does not flood the verification service.
const MAX_CHECKS = 3;
let activeChecks = 0;
const waitingChecks = [];

function drainChecks() {
  while (activeChecks < MAX_CHECKS && waitingChecks.length) {
    const { check, cancelled, resolve, reject } = waitingChecks.shift();
    if (cancelled()) { resolve(null); continue; }
    activeChecks += 1;
    Promise.resolve().then(check).then(resolve, reject).finally(() => {
      activeChecks -= 1;
      drainChecks();
    });
  }
}

function enqueueCheck(check, cancelled) {
  return new Promise((resolve, reject) => {
    waitingChecks.push({ check, cancelled, resolve, reject });
    drainChecks();
  });
}

/** Check the chain before showing a saved Pending receipt as the current state. */
export function LiveVerifiedBadge({ audit, recordStatus, onVerify, verificationKey, requireTransaction = false }) {
  const verifyRef = useRef(onVerify);
  verifyRef.current = onVerify;
  const [check, setCheck] = useState(null);
  const stored = verifiedStateFromAudit(audit, { recordStatus });
  const needsCheck = Boolean(onVerify && audit && stored !== VERIFIED_STATES.VERIFIED
    && (!requireTransaction || audit.transactionHash));
  const key = [verificationKey, audit?.status, audit?.transactionHash, audit?.contentHash, audit?.solutionHash].join(":");

  useEffect(() => {
    if (!needsCheck) return undefined;
    let cancelled = false;
    setCheck({ key, state: "checking" });
    enqueueCheck(() => verifyRef.current(), () => cancelled)
      .then((result) => {
        if (cancelled) return;
        setCheck({ key, state: result?.verified === true
          ? VERIFIED_STATES.VERIFIED
          : result?.verified === false ? VERIFIED_STATES.FAILED : "unavailable" });
      })
      .catch(() => { if (!cancelled) setCheck({ key, state: "unavailable" }); });
    return () => { cancelled = true; };
  }, [key, needsCheck]);

  if (!needsCheck) {
    return <VerifiedBadge audit={audit} recordStatus={recordStatus} hidePending={requireTransaction && !audit?.transactionHash} />;
  }
  if (!check || check.key !== key || check.state === "checking") {
    return <span className="table-row-meta" role="status">Checking verification…</span>;
  }
  if (check.state === "unavailable") {
    return <span className="table-row-meta" role="status">Verification unavailable</span>;
  }
  return <VerifiedBadge state={check.state} />;
}
