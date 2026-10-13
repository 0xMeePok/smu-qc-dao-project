const reasons = new Set(["funding_target_not_met", "no_proposal_selected", "selection_approval_timeout",
  "completion_approval_timeout", "selection_declined", "cancelled", "registry_invalidated", "escrow_voided",
  "admin_cancelled", "posting_expired"]);
const address = value => /^0x[0-9a-f]{40}$/i.test(value ?? "");
const digest = value => /^0x[0-9a-f]{64}$/i.test(value ?? "");
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const confirmed = row => row?.snapshotVerified === true || (row?.reconciliation?.complete === true && row?.reconciliation?.matched === true);
const refundedState = row => row?.refundsEnabled === true || ["Cancelled", "Expired", "Voided", "Refunded"].includes(row?.state);

/** Retain only anchored refund explanation metadata, never an older balance,
 * permission or lifecycle state. Immutable escrows cannot reopen after refund.
 * A different deployment, proposal or escrow starts with no inherited reason. */
export function confirmedRefundMetadata(current, previous) {
  if (!current || !previous || !confirmed(previous) || !reasons.has(previous.refundReason)
      || !digest(previous.refundTransactionHash) || !Number.isSafeInteger(previous.blockNumber) || previous.blockNumber < 0
      || !Number.isSafeInteger(current.blockNumber) || previous.blockNumber > current.blockNumber
      || current.proposalId !== previous.proposalId || !current.proposalId || current.chainId !== previous.chainId
      || !refundedState(current) || !refundedState(previous)
      || !address(current.registryAddress) || !same(current.registryAddress, previous.registryAddress)
      || !address(current.escrowAddress) || !same(current.escrowAddress, previous.escrowAddress)
      || !address(current.tokenAddress) || !same(current.tokenAddress, previous.tokenAddress)) return {};
  if (previous.proposalEntityId && !same(current.proposalEntityId, previous.proposalEntityId)) return {};
  return { refundReason: previous.refundReason, refundTransactionHash: previous.refundTransactionHash.toLowerCase(),
    refundReasonHash: digest(previous.refundReasonHash) ? previous.refundReasonHash.toLowerCase() : null };
}
