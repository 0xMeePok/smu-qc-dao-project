import { escrowCustodyLock } from "../../../firebase/functions/escrowCustody.js";
import { formatInstant } from "../lib/datetime.js";

const deadlines = {
  posting_window: "Posting closes",
  upfront_approval: "Upfront approval deadline",
  completion: "Completion approval deadline",
  refund_window: "Refunds available from",
};

function dateFromSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= 8_640_000_000_000
    ? new Date(seconds * 1000) : null;
}

export function EscrowCustodyNotice({ summary, compact = false, independent = false, stale = false }) {
  const custody = summary?.custodyLock ?? escrowCustodyLock(summary ?? {}, { independent: independent || summary?.workflow === "independent-crowdfunding" });
  const deadline = dateFromSeconds(custody.unlockAt), verifiedAt = dateFromSeconds(custody.verifiedAt);
  const checked = verifiedAt && <small> As of verified block at <time dateTime={verifiedAt.toISOString()}>{formatInstant(verifiedAt)}</time>.</small>;
  if (stale || custody.status === "unverified") return <p className="field-hint" data-custody-status="unverified">
    <strong>Custody lock status needs verification.</strong> Refresh the escrow to check its lock deadline and available refunds. An unavailable status does not make deposits withdrawable.
  </p>;
  if (custody.status === "empty") return <p className="field-hint" data-custody-status="empty"><strong>No deposited funds.</strong>{!compact && " Confirmed escrow holds no contributions to lock."}{checked}</p>;
  if (custody.status === "settled") return <p className="field-hint" data-custody-status="settled"><strong>Escrow settled.</strong> No unpaid balance remains in escrow.{checked}</p>;
  if (custody.status === "refundable") return <p className="field-hint" data-custody-status="refundable"><strong>Funds refundable.</strong> Eligible unpaid contributions can be claimed.{!compact && " Earlier payouts remain paid."}{checked}</p>;
  if (custody.status !== "locked") return null;
  return <p className="field-hint" data-custody-status="locked"><strong>Funds locked.</strong>{" "}
    {deadline && <>{deadlines[custody.reason] ?? "Lock deadline"}: <time dateTime={deadline.toISOString()}>{formatInstant(deadline)}</time>.{" "}</>}
    {!compact && <>{custody.reason === "upfront_approval" ? "Funds remain in escrow while the required upfront approvals are pending. The approval deadline controls this lock. "
      : custody.reason === "completion" ? "The unpaid balance remains in escrow for approved completion or an available refund. Posting expiry does not unlock accepted work; the completion approval deadline applies. "
        : "Posting expiry only opens eligible unpaid refunds; accepted work follows its approval deadline. "}
      Ordinary early withdrawals are unavailable. Approved payments and authorized rejection or cancellation refunds can settle funds earlier.</>}{checked}
  </p>;
}
