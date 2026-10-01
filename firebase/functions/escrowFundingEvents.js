import { decodeEventLog, encodeAbiParameters, keccak256 } from "viem";

export const FUNDING_EVENT_NAMES = ["EscrowCreated", "Deposit", "SelectionLocked", "Approval", "SelectionInvalidated",
  "Cancelled", "Expired", "MilestoneSubmitted", "TrancheReleased", "Voided", "RefundClaimed", "FunderVote"];
export const ESCROW_STATES = ["Open", "Locked", "Released", "Refunded", "Cancelled", "Expired", "Active", "Voided"];
export const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const value = (item, name, index) => item?.[name] ?? item?.[index];
const mismatch = message => { throw new Error(`Escrow reconciliation mismatch: ${message}`); };
export const fundingDigest = (types, values) => keccak256(encodeAbiParameters(types.map(type => ({ type })), values));
export const escrowEventId = (chainId, registry, transactionHash, logIndex) =>
  `${chainId}_${registry.toLowerCase()}_${transactionHash.toLowerCase()}_${logIndex}`;

function decode(log, abi) {
  try { return { ...log, ...decodeEventLog({ abi, topics: log.topics, data: log.data, strict: true }) }; }
  catch { return null; }
}

/** The registry digest is independently recomputed from the canonical escrow's
 * receipt logs. A submitted hash, amount, escrow address or "confirmed" flag is
 * never itself evidence. All values returned here came from that mined receipt. */
export async function reconcileFundingReceipt({ client, config, expected, escrowAddress, transactionHash, safeBlock }) {
  const receipt = await client.getTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== "success" || !same(receipt.transactionHash, transactionHash)
      || typeof receipt.blockNumber !== "bigint" || receipt.blockNumber > safeBlock) {
    throw new Error("The escrow transaction is not successfully confirmed yet.");
  }
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (!same(block.hash, receipt.blockHash)) mismatch("receipt is not in the canonical block");
  const registryLogs = receipt.logs.filter(log => same(log.address, config.address)).map(log => decode(log, config.abi)).filter(Boolean);
  const escrowLogs = receipt.logs.filter(log => same(log.address, escrowAddress)).map(log => decode(log, config.escrow.escrowAbi)).filter(Boolean);
  const anchors = registryLogs.filter(log => log.eventName === "FundingEventAnchored"
    && same(log.args.proposalId, expected.entityId) && same(log.args.escrow, escrowAddress));
  if (!anchors.length) mismatch("transaction has no anchor for this proposal's canonical escrow");
  if (anchors.length > 100) throw new Error("The transaction exceeds the bounded escrow reconciliation page.");
  const read = functionName => client.readContract({ address: escrowAddress, abi: config.escrow.escrowAbi,
    functionName, blockNumber: receipt.blockNumber });
  let stateReads;
  const state = () => stateReads ??= Promise.all([read("selectionId"), read("currentTranche"), read("expiresAt"), read("approvalDeadline")]);
  const used = new Set(), output = [];
  for (const anchor of anchors) {
    const { eventType, digest, actor, timestamp } = anchor.args;
    if (BigInt(timestamp) !== block.timestamp) mismatch("anchor timestamp differs from the receipt block");
    let candidates = [], amount = null, counterparty = null, selected = null;
    const add = (log, types, values, extra = {}) => candidates.push({ log, digest: fundingDigest(types, values), ...extra });
    const named = name => escrowLogs.filter(log => log.eventName === name && !used.has(log.logIndex));
    switch (Number(eventType)) {
      case 0:
        for (const log of registryLogs.filter(log => log.eventName === "ProposalEscrowLinked" && !used.has(log.logIndex)
            && same(log.args.proposalId, expected.entityId) && same(log.args.postingId, expected.opportunityId)
            && same(log.args.escrow, escrowAddress))) {
          if (same(actor, expected.expectedResearcher)) candidates.push({ log, digest: log.args.termsHash });
        }
        if (!same(digest, expected.fundingTermsHash)) mismatch("created escrow terms differ from the proposal");
        break;
      case 1:
        for (const log of named("Deposited")) {
          const a = log.args;
          if (!same(a.postingId, expected.opportunityId) || !same(a.proposalId, expected.entityId)
              || !same(a.token, expected.fundingTerms.token) || !same(a.depositor, actor)) continue;
          add(log, ["address", "uint256", "uint256"], [a.depositor, a.amount, a.cumulativeAmount],
            { amount: a.amount, counterparty: escrowAddress });
        }
        break;
      case 2:
        for (const log of named("SelectionLocked")) {
          const a = log.args;
          if (!same(a.solutionOwner, expected.expectedResearcher)) continue;
          add(log, ["bytes32", "address", "uint64"], [a.selectionId, a.solutionOwner, a.approvalDeadline]);
        }
        break;
      case 3:
        for (const log of named("SelectionApproved")) {
          const a = log.args;
          if (same(a.approver, actor)) add(log, ["bytes32", "uint256", "address"], [a.selectionId, 0n, actor]);
        }
        if (named("MilestoneApproved").length) {
          const [selectionId] = await state();
          for (const log of named("MilestoneApproved")) {
            const a = log.args;
            if (same(a.approver, actor)) add(log, ["bytes32", "uint256", "bytes32", "address"], [selectionId, a.index, a.evidenceHash, actor]);
          }
        }
        break;
      case 4:
        for (const log of named("SelectionInvalidated")) add(log, ["bytes32", "bytes32"], [log.args.selectionId, log.args.reasonHash]);
        break;
      case 5:
        candidates = named("Cancelled").map(log => ({ log, digest: log.args.reasonHash }));
        break;
      case 6: {
        const [, tranche, expiresAt, deadline] = await state();
        const changes = named("StateChanged").filter(log => Number(log.args.newState) === 5 && log.logIndex < anchor.logIndex);
        const changed = changes.at(-1);
        const refund = named("RefundsOpened").filter(log => log.logIndex < anchor.logIndex).at(-1);
        if (changed && refund) {
          const laterReleases = escrowLogs.filter(log => log.eventName === "TrancheReleased" && log.logIndex > anchor.logIndex).length;
          const previousState = Number(changed.args.previousState);
          let approvalExpiry = previousState === 6 || (previousState === 1
            && (config.abi.some(item => item.type === "function" && item.name === "pendingProposalForPosting")
              || config.escrow.escrowAbi.some(item => item.type === "function" && item.name === "rejectSelection")));
          // Grant escrows used their acceptance approval deadline before the
          // main workflow gained its separate pending-selection registry lock.
          if (previousState === 1 && !approvalExpiry && config.escrow.escrowAbi.some(item => item.type === "function" && item.name === "openFundingPool")) {
            const pool = await read("openFundingPool");
            approvalExpiry = /^0x[0-9a-f]{40}$/i.test(pool ?? "") && !/^0x0{40}$/i.test(pool);
          }
          add(refund, ["uint256", "uint256", "uint256"],
            [BigInt(tranche) - BigInt(laterReleases), approvalExpiry ? deadline : expiresAt, refund.args.pool]);
        }
        break;
      }
      case 7:
        for (const log of named("MilestoneSubmitted")) add(log, ["uint256", "bytes32"], [log.args.index, log.args.evidenceHash]);
        break;
      case 8:
        for (const log of named("TrancheReleased")) {
          const a = log.args;
          if (a.grossAmount !== a.fee + a.netAmount) mismatch("tranche fee and recipient amount do not add up");
          add(log, ["uint256", "bytes32", "uint256", "uint256"], [a.index, a.evidenceHash, a.grossAmount, a.fee],
            { amount: a.grossAmount, counterparty: expected.expectedResearcher, netAmount: a.netAmount, fee: a.fee, tranche: Number(a.index) });
        }
        break;
      case 9:
        candidates = named("EscrowVoided").filter(log => same(log.args.admin, actor)).map(log => ({ log, digest: log.args.reasonHash }));
        break;
      case 10:
        for (const log of named("RefundClaimed")) {
          const a = log.args;
          if (same(a.depositor, actor)) add(log, ["address", "uint256"], [a.depositor, a.amount], { amount: a.amount, counterparty: actor });
        }
        break;
      case 11:
        for (const log of named("MilestoneVoted")) {
          const a = log.args;
          if (same(a.voter, actor)) add(log, ["uint256", "bytes32", "address", "bool", "uint256"], [a.index, a.evidenceHash, actor, a.approve, a.weight]);
        }
        break;
      default: mismatch("unsupported funding event type");
    }
    selected = candidates.find(candidate => same(candidate.digest, digest));
    if (!selected) mismatch(`${FUNDING_EVENT_NAMES[Number(eventType)]} digest has no matching canonical escrow event`);
    used.add(selected.log.logIndex);
    amount = selected.amount?.toString() ?? null;
    counterparty = selected.counterparty?.toLowerCase() ?? null;
    output.push({ id: escrowEventId(config.chainId, config.address, transactionHash, anchor.logIndex),
      eventType: FUNDING_EVENT_NAMES[Number(eventType)], type: FUNDING_EVENT_NAMES[Number(eventType)],
      eventTypeCode: Number(eventType), digest: digest.toLowerCase(), actor: actor.toLowerCase(), counterparty,
      amountBaseUnits: amount, amount, netAmountBaseUnits: selected.netAmount?.toString() ?? null,
      feeBaseUnits: selected.fee?.toString() ?? null, tranche: selected.tranche ?? null,
      selectionId: selected.log.args.selectionId ?? null,
      tokenAddress: expected.fundingTerms.token.toLowerCase(), escrowAddress, registryAddress: config.address.toLowerCase(),
      chainId: config.chainId, transactionHash: transactionHash.toLowerCase(), blockNumber: Number(receipt.blockNumber),
      blockHash: receipt.blockHash, logIndex: anchor.logIndex, timestamp: Number(timestamp), verified: true });
  }
  const pairedEvents = new Set(["Deposited", "SelectionLocked", "SelectionApproved", "MilestoneApproved", "SelectionInvalidated",
    "Cancelled", "MilestoneSubmitted", "TrancheReleased", "EscrowVoided", "RefundClaimed", "MilestoneVoted"]);
  if (escrowLogs.some(log => pairedEvents.has(log.eventName) && !used.has(log.logIndex))) mismatch("an escrow event is missing its registry anchor");
  return output;
}

export function milestoneValue(milestone, name, index) { return value(milestone, name, index); }
