import { decodeEventLog } from "viem";

const same = (left, right) => left !== undefined && right !== undefined
  && String(left).toLowerCase() === String(right).toLowerCase();

/** Only effects emitted by the configured registry can attest an audit write. */
export function auditReceiptEvents(receipt, config) {
  const events = [];
  for (const log of receipt?.logs ?? []) {
    if (!same(log.address, config.address) || log.removed === true) continue;
    // RPC receipts bind their logs to the mined transaction. Refuse conflicting
    // metadata when present; raw Solidity logs need not repeat that metadata.
    if ((log.transactionHash && !same(log.transactionHash, receipt.transactionHash))
      || (log.blockHash && !same(log.blockHash, receipt.blockHash))
      || (log.blockNumber !== undefined && log.blockNumber !== null && log.blockNumber !== receipt.blockNumber)) continue;
    try {
      events.push(decodeEventLog({ abi: config.abi, topics: log.topics, data: log.data, strict: true }));
    } catch { /* Unrelated and malformed logs are not proof of a registry effect. */ }
  }
  return events;
}

export function opportunityReceiptEvent(receipt, config, expected, owner) {
  return auditReceiptEvents(receipt, config).find(({ eventName, args }) =>
    ["OpportunityCommitted", "OpportunityUpdated"].includes(eventName)
    && same(args.opportunityId, expected.entityId) && same(args.owner, owner)
    && same(args.contentHash, expected.contentHash) && same(args.expiresAt, expected.args[3])
    && (eventName !== "OpportunityCommitted" || same(args.kind, expected.args[1])));
}

export function proposalReceiptEvent(receipt, config, expected, researcher) {
  return auditReceiptEvents(receipt, config).find(({ eventName, args }) =>
    ["ProposalCommitted", "HashesUpdated"].includes(eventName)
    && same(args.proposalId, expected.entityId) && same(args.opportunityId, expected.opportunityId)
    && same(args.researcher, researcher) && same(args.proposalHash, expected.proposalHash)
    && same(args.solutionHash, expected.solutionHash));
}
