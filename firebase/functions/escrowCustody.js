// Shared display and selection rules. Inputs must come from one verified block;
// these projections never authorize a withdrawal or replace contract guards.
const MAIN_STATES = ["Open", "Locked", "Released", "Refunded", "Cancelled", "Expired", "Active", "Voided"];
const INDEPENDENT_STATES = ["Open", "Accepted", "Released", "Declined", "Expired", "Cancelled", "Refunded"];
const uint = value => {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return null;
  if (typeof value !== "bigint" && typeof value !== "number" && (typeof value !== "string" || !/^\d{1,78}$/.test(value))) return null;
  try { const result = BigInt(value); return result >= 0n && result < 2n ** 256n ? result : null; } catch { return null; }
};
const instant = value => {
  const result = uint(value);
  return result !== null && result > 0n && result <= 8_640_000_000_000n ? result : null;
};
const stateOf = (summary, independent) => typeof summary?.state === "number"
  ? (independent ? INDEPENDENT_STATES : MAIN_STATES)[summary.state] : summary?.state;

/** Donations cannot meet the funding requirement; confirmed custody must cover
 * the exact recorded target before selection can consume that requirement. */
export function escrowFundingRequirementMet(summary = {}) {
  const target = uint(summary.fundingTarget), deposited = uint(summary.totalDeposited);
  const held = uint(summary.outstandingBalance), custody = uint(summary.custodyBalance);
  const released = uint(summary.totalReleased), refunded = uint(summary.totalRefunded);
  return target !== null && target > 0n && deposited === target
    && held !== null && held >= target && custody !== null && custody >= held
    && released !== null && refunded !== null && deposited === held + released + refunded;
}

/** Feedback remains advisory. The same funding predicate is used by display,
 * selection requests and the platform worker's fresh preflight. */
export function escrowSelectionGate(summary = {}) {
  const fundingMet = escrowFundingRequirementMet(summary);
  const deadline = instant(summary.expiresAt), timestamp = instant(summary.timestamp);
  return { fundingMet, feedbackRequired: false,
    canSelect: fundingMet && stateOf(summary, false) === "Open" && summary.active === true
      && deadline !== null && timestamp !== null && timestamp < deadline };
}

/** Describe the contract's existing lock, including authorized early refunds
 * and the separate upfront/completion deadlines after selection. */
export function escrowCustodyLock(summary = {}, { independent = summary.workflow === "independent-crowdfunding" } = {}) {
  const state = stateOf(summary, independent);
  const held = uint(summary.outstandingBalance), deposited = uint(summary.totalDeposited);
  const timestamp = instant(summary.timestamp);
  const result = { status: "unverified", unlockAt: null, reason: null,
    verifiedAt: timestamp?.toString() ?? null };
  if (held === null || deposited === null || !(independent ? INDEPENDENT_STATES : MAIN_STATES).includes(state)) return result;
  if (held === 0n) return { ...result, status: deposited === 0n ? "empty" : "settled" };
  if (timestamp === null) return result;

  let deadline, reason;
  if (summary.refundsEnabled === true) {
    if (independent) return { ...result, status: "refundable", reason: "authorized_refund" };
    deadline = instant(summary.refundAvailableAt);
    reason = "refund_window";
  } else if (independent && ["Declined", "Cancelled", "Expired"].includes(state)) {
    return { ...result, status: "refundable", reason: "authorized_refund" };
  } else if (state === "Open") {
    deadline = instant(summary.expiresAt);
    reason = "posting_window";
  } else if (!independent && ["Locked", "Active"].includes(state)) {
    const originalPostingWindow = state === "Locked" && summary.upfrontRefundUsesApprovalDeadline === false;
    deadline = instant(originalPostingWindow ? summary.expiresAt : summary.approvalDeadline);
    reason = originalPostingWindow ? "posting_window" : state === "Locked" ? "upfront_approval" : "completion";
  } else if (independent && state === "Accepted") {
    deadline = instant(summary.completionDeadline);
    reason = "completion";
  }
  if (deadline === null || deadline === undefined) return result;
  return { ...result, status: timestamp < deadline ? "locked" : "refundable",
    unlockAt: deadline.toString(), reason };
}
