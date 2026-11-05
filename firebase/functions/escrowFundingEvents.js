import { decodeEventLog, encodeAbiParameters, keccak256, stringToHex } from "viem";

export const FUNDING_EVENT_NAMES = ["EscrowCreated", "Deposit", "SelectionLocked", "Approval", "SelectionInvalidated",
  "Cancelled", "Expired", "MilestoneSubmitted", "TrancheReleased", "Voided", "RefundClaimed", "FunderVote"];
export const ESCROW_STATES = ["Open", "Locked", "Released", "Refunded", "Cancelled", "Expired", "Active", "Voided"];
export const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const value = (item, name, index) => item?.[name] ?? item?.[index];
const mismatch = message => { throw new Error(`Escrow reconciliation mismatch: ${message}`); };
const registryWithdrawal = keccak256(stringToHex("REGISTRY_WITHDRAWAL"));
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
export async function reconcileFundingReceipt(options) {
  return (await reconcileFundingReceiptPage({ ...options, anchorOffset: 0, anchorLimit: Infinity })).events;
}

/** Validate the entire canonical receipt before returning a bounded projection
 * page. In particular, an unpaired event beyond this page must still fail it.
 * Receipt RPC responses are atomic; pages bound event writes, not RPC bytes. */
export async function reconcileFundingReceiptPage({ client, config, expected, escrowAddress, transactionHash, safeBlock,
  anchorOffset = 0, anchorLimit = 100 }) {
  if (!Number.isSafeInteger(anchorOffset) || anchorOffset < 0
      || !(anchorLimit === Infinity || Number.isSafeInteger(anchorLimit) && anchorLimit > 0)) {
    throw new Error("Invalid escrow receipt page.");
  }
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
  if (anchorOffset >= anchors.length) mismatch("saved receipt page is outside its anchors");
  const endOffset = Math.min(anchors.length, anchorOffset + anchorLimit);
  const read = functionName => client.readContract({ address: escrowAddress, abi: config.escrow.escrowAbi,
    functionName, blockNumber: receipt.blockNumber });
  let stateReads;
  const state = () => stateReads ??= Promise.all([read("selectionId"), read("currentTranche"), read("expiresAt"), read("approvalDeadline")]);
  const used = new Set(), output = [], byName = new Map(), candidateIndexes = new Map();
  for (const log of escrowLogs) {
    if (!byName.has(log.eventName)) byName.set(log.eventName, []);
    byName.get(log.eventName).push(log);
  }
  // Dense deposits and votes must not recompute every log's digest for every
  // anchor. Cache each event's independently encoded digest once per receipt.
  const indexed = (name, build, digest, predicate = () => true) => {
    if (!candidateIndexes.has(name)) {
      const index = new Map();
      for (const log of byName.get(name) || []) {
        const entry = build(log);
        if (!entry) continue;
        const key = entry.digest.toLowerCase();
        if (!index.has(key)) index.set(key, { rows: [], offset: 0 });
        index.get(key).rows.push({ log, ...entry });
      }
      candidateIndexes.set(name, index);
    }
    const bucket = candidateIndexes.get(name).get(digest.toLowerCase());
    if (!bucket) return [];
    while (bucket.offset < bucket.rows.length && used.has(bucket.rows[bucket.offset].log.logIndex)) bucket.offset++;
    for (let index = bucket.offset; index < bucket.rows.length; index++) {
      const entry = bucket.rows[index];
      if (!used.has(entry.log.logIndex) && predicate(entry.log)) return [entry];
    }
    return [];
  };
  const lastBefore = (rows, logIndex) => {
    let low = 0, high = rows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (rows[middle].logIndex < logIndex) low = middle + 1;
      else high = middle;
    }
    return rows[low - 1] ?? null;
  };
  for (const [anchorIndex, anchor] of anchors.entries()) {
    const { eventType, digest, actor, timestamp } = anchor.args;
    if (BigInt(timestamp) !== block.timestamp) mismatch("anchor timestamp differs from the receipt block");
    let candidates = [], amount = null, counterparty = null, selected = null;
    const add = (log, types, values, extra = {}) => candidates.push({ log, digest: fundingDigest(types, values), ...extra });
    const named = name => (byName.get(name) || []).filter(log => !used.has(log.logIndex));
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
        candidates = indexed("Deposited", log => {
          const a = log.args;
          if (!same(a.postingId, expected.opportunityId) || !same(a.proposalId, expected.entityId)
              || !same(a.token, expected.fundingTerms.token)) return null;
          return { digest: fundingDigest(["address", "uint256", "uint256"], [a.depositor, a.amount, a.cumulativeAmount]),
            amount: a.amount, counterparty: escrowAddress };
        }, digest, log => same(log.args.depositor, actor));
        break;
      case 2:
        candidates = indexed("SelectionLocked", log => {
          const a = log.args;
          if (!same(a.solutionOwner, expected.expectedResearcher)) return null;
          return { digest: fundingDigest(["bytes32", "address", "uint64"], [a.selectionId, a.solutionOwner, a.approvalDeadline]) };
        }, digest);
        break;
      case 3:
        candidates = indexed("SelectionApproved", log => {
          const a = log.args;
          return { digest: fundingDigest(["bytes32", "uint256", "address"], [a.selectionId, 0n, a.approver]), tranche: 0 };
        }, digest, log => same(log.args.approver, actor));
        if (byName.has("MilestoneApproved")) {
          const [selectionId] = await state();
          candidates.push(...indexed("MilestoneApproved", log => {
            const a = log.args;
            return { digest: fundingDigest(["bytes32", "uint256", "bytes32", "address"], [selectionId, a.index, a.evidenceHash, a.approver]), tranche: Number(a.index) };
          }, digest, log => same(log.args.approver, actor)));
        }
        break;
      case 4:
        candidates = indexed("SelectionInvalidated", log => ({ digest: fundingDigest(["bytes32", "bytes32"], [log.args.selectionId, log.args.reasonHash]) }), digest);
        break;
      case 5:
        candidates = indexed("Cancelled", log => ({ digest: log.args.reasonHash }), digest);
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
          const expiredDeadline = approvalExpiry ? deadline : expiresAt;
          let refundReason = previousState === 6 ? "completion_approval_timeout" : previousState === 1 ? "selection_approval_timeout" : "posting_expired";
          if (previousState === 0 && expected.fundingTerms.target !== undefined) {
            const deposited = await read("totalDeposited");
            if (typeof deposited !== "bigint" || deposited < 0n || deposited > BigInt(expected.fundingTerms.target)) mismatch("expiry funding total cannot be verified");
            refundReason = deposited < BigInt(expected.fundingTerms.target) ? "funding_target_not_met" : "no_proposal_selected";
          }
          add(refund, ["uint256", "uint256", "uint256"],
            [BigInt(tranche) - BigInt(laterReleases), expiredDeadline, refund.args.pool],
            { refundReason, deadlineAt: String(expiredDeadline), tranche: Number(tranche) - laterReleases });
        }
        break;
      }
      case 7:
        candidates = indexed("MilestoneSubmitted", log => ({ digest: fundingDigest(["uint256", "bytes32"], [log.args.index, log.args.evidenceHash]) }), digest);
        break;
      case 8:
        candidates = indexed("TrancheReleased", log => {
          const a = log.args;
          if (a.grossAmount !== a.fee + a.netAmount) mismatch("tranche fee and recipient amount do not add up");
          return { digest: fundingDigest(["uint256", "bytes32", "uint256", "uint256"], [a.index, a.evidenceHash, a.grossAmount, a.fee]),
            amount: a.grossAmount, counterparty: expected.expectedResearcher, netAmount: a.netAmount, fee: a.fee, tranche: Number(a.index) };
        }, digest);
        break;
      case 9:
        candidates = indexed("EscrowVoided", log => ({ digest: log.args.reasonHash }), digest, log => same(log.args.admin, actor));
        break;
      case 10:
        candidates = indexed("RefundClaimed", log => {
          const a = log.args;
          return { digest: fundingDigest(["address", "uint256"], [a.depositor, a.amount]), amount: a.amount, counterparty: a.depositor };
        }, digest, log => same(log.args.depositor, actor));
        break;
      case 11:
        candidates = indexed("MilestoneVoted", log => {
          const a = log.args;
          return { digest: fundingDigest(["uint256", "bytes32", "address", "bool", "uint256"], [a.index, a.evidenceHash, a.voter, a.approve, a.weight]) };
        }, digest, log => same(log.args.voter, actor));
        break;
      default: mismatch("unsupported funding event type");
    }
    selected = candidates.find(candidate => same(candidate.digest, digest));
    if (!selected) mismatch(`${FUNDING_EVENT_NAMES[Number(eventType)]} digest has no matching canonical escrow event`);
    used.add(selected.log.logIndex);
    if (anchorIndex < anchorOffset || anchorIndex >= endOffset) continue;
    amount = selected.amount?.toString() ?? null;
    counterparty = selected.counterparty?.toLowerCase() ?? null;
    const name = FUNDING_EVENT_NAMES[Number(eventType)];
    const refund = ["SelectionInvalidated", "Cancelled", "Expired", "Voided"].includes(name)
      ? lastBefore(byName.get("RefundsOpened") || [], anchor.logIndex) : null;
    const reasonHash = selected.log.args.reasonHash?.toLowerCase() ?? null;
    const refundReason = selected.refundReason ?? (name === "SelectionInvalidated" ? "selection_declined"
      : name === "Cancelled" ? "cancelled" : name === "Voided" ? same(reasonHash, registryWithdrawal) ? "registry_invalidated" : "escrow_voided" : null);
    const precedingAnchor = anchors[anchorIndex - 1]?.logIndex ?? -1;
    const previousChange = lastBefore(byName.get("StateChanged") || [], anchor.logIndex);
    const change = previousChange?.logIndex > precedingAnchor ? previousChange : null;
    output.push({ id: escrowEventId(config.chainId, config.address, transactionHash, anchor.logIndex),
      eventType: FUNDING_EVENT_NAMES[Number(eventType)], type: FUNDING_EVENT_NAMES[Number(eventType)],
      eventTypeCode: Number(eventType), digest: digest.toLowerCase(), actor: actor.toLowerCase(), counterparty,
      amountBaseUnits: amount, amount, netAmountBaseUnits: selected.netAmount?.toString() ?? null,
      feeBaseUnits: selected.fee?.toString() ?? null, tranche: selected.tranche ?? null,
      selectionId: selected.log.args.selectionId ?? null,
      reasonHash, refundReason, refundPoolBaseUnits: refund ? String(refund.args.pool) : null,
      refundAvailableAt: refund ? String(refund.args.availableAt) : null,
      deadlineAt: selected.deadlineAt ?? (name === "SelectionLocked" ? String(selected.log.args.approvalDeadline) : null),
      stateBefore: change ? ESCROW_STATES[Number(change.args.previousState)] ?? null : null,
      stateAfter: change ? ESCROW_STATES[Number(change.args.newState)] ?? null : null,
      tokenAddress: expected.fundingTerms.token.toLowerCase(), escrowAddress, registryAddress: config.address.toLowerCase(),
      chainId: config.chainId, transactionHash: transactionHash.toLowerCase(), blockNumber: Number(receipt.blockNumber),
      blockHash: receipt.blockHash, logIndex: anchor.logIndex, timestamp: Number(timestamp), verified: true });
  }
  const pairedEvents = new Set(["Deposited", "SelectionLocked", "SelectionApproved", "MilestoneApproved", "SelectionInvalidated",
    "Cancelled", "MilestoneSubmitted", "TrancheReleased", "EscrowVoided", "RefundClaimed", "MilestoneVoted"]);
  if (escrowLogs.some(log => pairedEvents.has(log.eventName) && !used.has(log.logIndex))) mismatch("an escrow event is missing its registry anchor");
  return { events: output, anchorCount: anchors.length,
    nextAnchorOffset: endOffset < anchors.length ? endOffset : null,
    blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
}

export function milestoneValue(milestone, name, index) { return value(milestone, name, index); }
