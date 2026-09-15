/**
 * Compact on-chain verification states for QCDAO-80.
 * These describe the stored Firestore audit receipt, not workflow status
 * (Draft / Open / Expired) and not a live AuditRegistry read.
 */
export const VERIFIED_STATES = Object.freeze({
  VERIFIED: "verified",
  PENDING: "pending",
  FAILED: "failed",
  NOT_ANCHORED: "not-anchored",
});

export const VERIFIED_BADGE_COPY = Object.freeze({
  [VERIFIED_STATES.VERIFIED]: {
    label: "Verified",
    ariaLabel: "On-chain verification: verified",
  },
  [VERIFIED_STATES.PENDING]: {
    label: "Pending",
    ariaLabel: "On-chain verification: pending",
  },
  [VERIFIED_STATES.FAILED]: {
    label: "Failed",
    ariaLabel: "On-chain verification: failed",
  },
  [VERIFIED_STATES.NOT_ANCHORED]: {
    label: "Not anchored",
    ariaLabel: "On-chain verification: not anchored",
  },
});

const PENDING_RECEIPT_STATUSES = new Set(["queued", "submitted", "pending"]);
const FAILED_RECEIPT_STATUSES = new Set(["failed", "mismatch"]);

/**
 * Map a stored audit receipt (and optional record workflow status) onto the
 * four-state verified badge. Unknown or missing receipts are not anchored.
 */
export function verifiedStateFromAudit(audit, { recordStatus } = {}) {
  if (String(recordStatus ?? "").trim().toLowerCase() === "draft") {
    return VERIFIED_STATES.NOT_ANCHORED;
  }

  const status = String(audit?.status ?? "").trim().toLowerCase();
  if (!status) return VERIFIED_STATES.NOT_ANCHORED;
  if (status === "confirmed") return VERIFIED_STATES.VERIFIED;
  if (PENDING_RECEIPT_STATUSES.has(status)) return VERIFIED_STATES.PENDING;
  if (FAILED_RECEIPT_STATUSES.has(status)) return VERIFIED_STATES.FAILED;
  return VERIFIED_STATES.NOT_ANCHORED;
}
