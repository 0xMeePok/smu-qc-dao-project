import { createRequestReadClient } from "./requestReadClient.js";
import { boundedMap } from "./boundedMap.js";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { decodeEventLog, encodeFunctionData, erc20Abi } from "viem";
import { prepareOpportunityCommit } from "./auditCanonical.js";
import { fundingOpportunityAuditPayload } from "./opportunityAuditPayload.js";
import { canReadContent, memberNoticeFields } from "./moderation.js";
import { prepareStoredProposal } from "./proposalAuditPayload.js";
import { verifyProposalEscrow, requireAddress } from "./escrowAudit.js";
import { deploymentKey, enqueueEscrowFunding, loadFundingContext } from "./escrowFunding.js";
import { same } from "./escrowFundingEvents.js";
import { OPEN_FUNDING_SELECTIONS, saveFundingSnapshot } from "./fundingSnapshots.js";
export { OPEN_FUNDING_SELECTIONS } from "./fundingSnapshots.js";

export const OPEN_FUNDING_SUMMARIES = "openFundingSummaries";
const ZERO_ADDRESS = `0x${"0".repeat(40)}`, MAX_PROPOSALS = 100, UINT256 = (1n << 256n) - 1n;
const OFFER_STATES = ["none", "pending", "accepted", "voided"];
const fail = (code, message) => { throw new HttpsError(code, message); };
const at = (row, name, index) => row?.[name] ?? row?.[index];
const hidden = row => row?.moderated || ["hidden", "removed"].includes(row?.moderationStatus);
const validId = id => { if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail("invalid-argument", "A valid opportunity reference is required."); };
const hasFunctions = (abi, names) => names.every(name => abi?.some(item => item.type === "function" && item.name === name));
export function supportsOpenFunding(config) {
  return config?.contractName === "EscrowAuditRegistry"
    && hasFunctions(config.escrow?.factoryAbi, ["openFundingPoolForPosting", "createOpenFundingPool"])
    && hasFunctions(config.escrow?.openFundingPoolAbi, ["postingId", "owner", "token", "tokenDecimals", "factory", "auditRegistry", "totalDeposited", "totalAllocated", "totalWithdrawn", "reservedAmount", "getOffer", "proposalCount", "proposalAt", "availableBalance", "deposit", "selectProposal", "acceptProposal", "expireProposal", "withdrawAvailable"])
    && hasFunctions(config.escrow?.escrowAbi, ["openFundingPool"]);
}
export async function assertOpenFundingChain(client, config) {
  if (!supportsOpenFunding(config)) fail("failed-precondition", "Open funding grants require the updated smart contracts and deployment manifest. This deployment is read-only for grants.");
  if (config.chainId !== 421614 || await client.getChainId() !== config.chainId) fail("failed-precondition", "Open funding requires the configured Arbitrum Sepolia deployment.");
}
async function contextFor({ db, uid, problemId }) {
  validId(problemId);
  const [posting, profile] = await Promise.all([db.collection("problems").doc(problemId).get(), db.collection("users").doc(uid).get()]);
  if (!profile.exists || profile.data().suspended) fail("permission-denied", "An active member profile is required.");
  if (!posting.exists || !await canReadContent({ get: ref => ref.get() }, db, "problem", posting.data(), uid, profile.data())) fail("permission-denied", "This opportunity is not available to your account.");
  const record = { ...posting.data(), id: posting.id };
  if (record.opportunityType !== "open-funding") fail("failed-precondition", "This posting does not use the open funding grant workflow.");
  return { record, profile: profile.data() };
}
function expectedPosting(record, config) {
  return prepareOpportunityCommit({ recordId: record.id, actor: config.entityIdScheme === 2 ? record.ownerId : undefined,
    payload: fundingOpportunityAuditPayload(record), kind: 1, expiresAt: record.expiresAt, hashScheme: record.audit?.schemaVersion ?? 1 });
}
function tokenFor(config, address) {
  const token = config.escrow?.tokens?.find(row => same(row.address, address));
  if (!token || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 77) fail("failed-precondition", "Choose a token supported by this deployment.");
  return { tokenAddress: requireAddress(token.address, "Funding token"), tokenSymbol: token.symbol, tokenDecimals: token.decimals };
}
function positiveUnits(value) {
  if (typeof value !== "string" || value.length > 78 || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > UINT256) fail("invalid-argument", "Enter a positive integer amount in token base units.");
  return value;
}

/** Immutable custody links and every balance are read at the same confirmed block. */
export async function readOpenFunding({ db, client, config, uid, problemId, proposalId, blockNumber, includeSelections = true }) {
  client = createRequestReadClient(client, { chainId: config.chainId });
  const context = await contextFor({ db, uid, problemId }), { record, profile } = context;
  if (!supportsOpenFunding(config)) return { supported: false, exists: false, problemId, title: record.title || "Open funding",
    owner: record.ownerId, selections: [], message: "Open funding grants require the updated smart contracts and deployment manifest." };
  await assertOpenFundingChain(client, config);
  blockNumber ??= await client.getBlockNumber({ cacheTime: 0 }) - 1n;
  if (blockNumber < 0n) fail("unavailable", "Wait for a confirmed chain block.");
  // Opportunity audit delivery remains `pending` in Firestore: client rules
  // deliberately reject `confirmed`, and publication attestation already binds
  // the saved content to this transaction. Verify the chain facts below rather
  // than treating client delivery status as proof of confirmation.
  if (!["submitted", "open", "expired", "cancelled", "withdrawn"].includes(record.status)
      || !/^0x[0-9a-f]{64}$/i.test(record.audit?.transactionHash ?? "")) fail("failed-precondition", "Publish the opportunity and confirm its chain transaction before creating the grant pool.");
  const expected = expectedPosting(record, config), factoryAddress = requireAddress(config.escrow.factoryAddress, "Funding factory");
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber });
  const [receipt, posting, factory, registry, poolAddress, block, paused] = await Promise.all([
    client.getTransactionReceipt({ hash: record.audit.transactionHash }),
    read(config.address, config.abi, "getOpportunity", [expected.entityId]),
    read(config.address, config.abi, "fundingFactory"), read(factoryAddress, config.escrow.factoryAbi, "auditRegistry"),
    read(factoryAddress, config.escrow.factoryAbi, "openFundingPoolForPosting", [expected.entityId]), client.getBlock({ blockNumber }),
    read(config.address, config.abi, "postingFundingPaused", [expected.entityId]),
  ]);
  if (receipt.status !== "success" || !same(receipt.transactionHash, record.audit.transactionHash)
      || !same(receipt.to, config.address) || typeof receipt.blockNumber !== "bigint" || receipt.blockNumber > blockNumber) {
    fail("failed-precondition", "The opportunity's publication transaction is not confirmed on this registry deployment.");
  }
  const receiptBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (!receipt.blockHash || !same(receipt.blockHash, receiptBlock.hash)) fail("failed-precondition", "The opportunity's publication transaction is not in the canonical chain.");
  if (!same(at(posting, "owner", 0), record.ownerId) || Number(at(posting, "kind", 1)) !== 1
      || !same(at(posting, "contentHash", 2), expected.contentHash) || !same(at(posting, "expiresAt", 5), expected.args[3])
      || !same(factory, factoryAddress) || !same(registry, config.address)) fail("failed-precondition", "The grant opportunity or custody factory differs from its verified registry record.");
  const closed = at(posting, "withdrawn", 6) || BigInt(at(posting, "expiresAt", 5)) <= block.timestamp;
  const live = !closed && !paused && !hidden(record) && ["submitted", "open"].includes(record.status);
  const isOwner = same(uid, record.ownerId);
  const base = { supported: true, exists: !same(poolAddress, ZERO_ADDRESS), problemId, title: record.title || "Open funding", owner: record.ownerId,
    postingId: expected.entityId, poolAddress: same(poolAddress, ZERO_ADDRESS) ? null : requireAddress(poolAddress, "Grant pool"), chainId: config.chainId,
    blockNumber: Number(blockNumber), timestamp: Number(block.timestamp), closed: Boolean(closed), withdrawn: Boolean(at(posting, "withdrawn", 6)), paused: Boolean(paused),
    canCreate: isOwner && live && same(poolAddress, ZERO_ADDRESS), canDeposit: false, canSelect: false, canWithdraw: false,
    totalDeposited: "0", totalAllocated: "0", totalReserved: "0", totalWithdrawn: "0", available: "0", selections: [], truncated: false };
  if (!base.exists) return { ...base, ...tokenFor(config, config.escrow.tokens.find(row => row.symbol === record.currency)?.address) };
  const poolRead = name => read(base.poolAddress, config.escrow.openFundingPoolAbi, name);
  const names = ["postingId", "owner", "token", "tokenDecimals", "factory", "auditRegistry", "totalDeposited", "totalAllocated", "totalWithdrawn", "reservedAmount", "availableBalance", "proposalCount"];
  const fields = Object.fromEntries((await Promise.all(names.map(poolRead))).map((value, index) => [names[index], value]));
  const token = tokenFor(config, fields.token);
  if (!same(fields.postingId, expected.entityId) || !same(fields.owner, record.ownerId) || Number(fields.tokenDecimals) !== token.tokenDecimals
      || !same(fields.factory, factoryAddress) || !same(fields.auditRegistry, config.address)) fail("failed-precondition", "The canonical grant pool has mismatched ownership or token terms.");
  if (BigInt(fields.totalDeposited) !== BigInt(fields.totalAllocated) + BigInt(fields.totalWithdrawn) + BigInt(fields.reservedAmount) + BigInt(fields.availableBalance)) fail("failed-precondition", "Grant pool balances do not reconcile.");
  Object.assign(base, token, { totalDeposited: String(fields.totalDeposited), totalAllocated: String(fields.totalAllocated),
    totalWithdrawn: String(fields.totalWithdrawn), totalReserved: String(fields.reservedAmount), available: String(fields.availableBalance),
    canDeposit: isOwner && !at(posting, "withdrawn", 6) && !paused && !hidden(record) && ["submitted", "open", "expired"].includes(record.status),
    canSelect: isOwner && live && BigInt(fields.availableBalance) > 0n,
    canWithdraw: isOwner && Boolean(closed) && BigInt(fields.availableBalance) > 0n });
  if (!includeSelections) return base;
  const count = BigInt(fields.proposalCount), cap = count > BigInt(MAX_PROPOSALS) ? MAX_PROPOSALS : Number(count);
  const [ids, proposals] = await Promise.all([
    boundedMap(Array.from({ length: cap }, (_, i) => i), i => read(base.poolAddress, config.escrow.openFundingPoolAbi, "proposalAt", [BigInt(i)])),
    db.collection("proposals").where("problemId", "==", problemId).limit(MAX_PROPOSALS + 1).get(),
  ]);
  const docs = proposals.docs.slice(0, MAX_PROPOSALS);
  if (proposalId && !docs.some(doc => doc.id === proposalId)) {
    validId(proposalId);
    const target = await db.collection("proposals").doc(proposalId).get();
    if (target.exists && target.data().problemId === problemId) docs.push(target);
  }
  const records = new Map();
  for (const doc of docs) {
    const row = { ...doc.data(), id: doc.id };
    if (row.status === "draft" || row.audit?.status !== "confirmed") continue;
    if (!isOwner && profile.role !== 1 && !same(row.researcherId, uid)) continue;
    if (hidden(row) && !isOwner && !same(row.researcherId, uid) && profile.role !== 1) continue;
    try {
      const expected = prepareStoredProposal(row, { registryConfig: config });
      records.set(expected.entityId.toLowerCase(), { row, expected });
      if (!ids.some(id => same(id, expected.entityId))) ids.push(expected.entityId);
    } catch { /* Incomplete drafts have no escrow. */ }
  }
  const offers = await boundedMap(ids, id => read(base.poolAddress, config.escrow.openFundingPoolAbi, "getOffer", [id]));
  const selections = await boundedMap(ids, async (_, index) => {
    const candidate = records.get(ids[index].toLowerCase());
    if (!candidate) return null;
    const { row: proposal, expected } = candidate;
    const offer = offers[index], state = Number(at(offer, "state", 2)), deadline = BigInt(at(offer, "acceptanceDeadline", 1));
    if (!OFFER_STATES[state]) fail("failed-precondition", "The grant selection state cannot be verified.");
    const expired = state === 1 && deadline <= block.timestamp;
    let escrowAddress, deposited, active, invalidated;
    try {
      const escrow = await verifyProposalEscrow({ expected, config, readContract: request => client.readContract({ ...request, blockNumber }) });
      escrowAddress = escrow.address;
      const [linkedPool, actual, paid, fundingActive, fundingInvalidated] = await Promise.all([
        read(escrowAddress, config.escrow.escrowAbi, "openFundingPool"), read(config.address, config.abi, "getProposal", [expected.entityId]),
        read(escrowAddress, config.escrow.escrowAbi, "totalDeposited"),
        read(config.address, config.abi, "isFundingActive", [expected.entityId, escrowAddress]),
        read(config.address, config.abi, "isFundingInvalidated", [expected.entityId, escrowAddress]),
      ]);
      if (!same(linkedPool, base.poolAddress) || !same(expected.fundingTerms.token, base.tokenAddress)
          || !same(at(actual, "researcher", 0), expected.expectedResearcher) || !same(at(actual, "opportunityId", 1), expected.opportunityId)
          || !same(at(actual, "proposalHash", 4), expected.proposalHash) || !same(at(actual, "solutionHash", 5), expected.solutionHash)) return null;
      deposited = BigInt(paid); active = fundingActive; invalidated = fundingInvalidated;
    } catch { return null; }
    return { proposalId: proposal.id, entityId: ids[index], title: proposal.title || "Proposal", researcherId: proposal.researcherId,
      escrowAddress, amountBaseUnits: state === 0 ? expected.fundingTerms.target.toString() : String(at(offer, "amount", 0)), acceptanceDeadline: deadline.toString(),
      status: expired ? "expired" : OFFER_STATES[state], canAccept: state === 1 && !expired && active && !hidden(proposal) && !hidden(record) && same(uid, proposal.researcherId),
      canVoid: state === 1 && (expired || invalidated), canSelect: isOwner && live && active && state === 0 && deposited === 0n
        && expected.fundingTerms.target <= BigInt(base.available) && ["submitted", "under_review"].includes(proposal.status) && !hidden(proposal) };
  });
  base.selections = selections.filter(Boolean);
  base.truncated = count > BigInt(MAX_PROPOSALS) || proposals.size > MAX_PROPOSALS;
  return base;
}
export async function getOpenFundingSummary(options) {
  const summary = await readOpenFunding(options);
  await saveOpenFundingSnapshot({ ...options, summary });
  return summary;
}

export async function saveOpenFundingSnapshot({ db, config, summary, now = Timestamp.now() }) {
  if (!summary.supported || !Number.isSafeInteger(summary.blockNumber)) return;
  // Offers are scoped to the caller. Keep them in server-only documents so
  // a researcher's partial view cannot replace the owner's complete set or
  // expose other proposals through the member-readable pool totals.
  const { selections, ...totals } = summary;
  const metadata = { registryAddress: config.address.toLowerCase(), confirmedAt: now.toDate().toISOString() };
  await saveFundingSnapshot({ db, collection: OPEN_FUNDING_SUMMARIES,
    id: `${deploymentKey(config)}_${summary.problemId}`, snapshot: { ...totals, ...metadata } });
  await boundedMap(selections || [], async selection => {
    const { canAccept, canVoid, canSelect, ...saved } = selection;
    await saveFundingSnapshot({ db, collection: OPEN_FUNDING_SELECTIONS,
      id: `${deploymentKey(config)}_${selection.proposalId}`, snapshot: {
        ...saved, ...metadata, problemId: summary.problemId, owner: summary.owner, poolAddress: summary.poolAddress,
        chainId: config.chainId, blockNumber: summary.blockNumber,
      } });
  });
}

/** Returns a reviewable wallet request. The backend never signs or moves grant funds. */
export async function prepareOpenFundingAction(options) {
  options = { ...options, client: createRequestReadClient(options.client, { chainId: options.config.chainId }) };
  const { db, client, config, uid, problemId, proposalId, action } = options;
  if (!supportsOpenFunding(config)) fail("failed-precondition", "Open funding grants require the updated smart contracts and deployment manifest. This deployment is read-only for grants.");
  // Pool checks are always fresh; action-specific proposal checks follow below.
  const summary = await readOpenFunding({ ...options, includeSelections: false });
  let address = summary.poolAddress, contractType = "pool", functionName, args, amountBaseUnits;
  let token = { tokenAddress: summary.tokenAddress, tokenSymbol: summary.tokenSymbol, tokenDecimals: summary.tokenDecimals };
  if (action === "create") {
    if (!summary.canCreate) fail("permission-denied", "Only the owner of a live opportunity without a grant pool may create it.");
    token = tokenFor(config, options.tokenAddress || summary.tokenAddress);
    if (!same(token.tokenAddress, summary.tokenAddress)) fail("failed-precondition", "The grant pool token must match the posting's currency.");
    address = config.escrow.factoryAddress; contractType = "factory"; functionName = "createOpenFundingPool"; args = [summary.postingId, token.tokenAddress];
  } else if (action === "deposit" || action === "withdraw") {
    if (!summary.exists || !(action === "deposit" ? summary.canDeposit : summary.canWithdraw)) fail("permission-denied", action === "deposit" ? "Only the owner can deposit into a live grant pool." : "The owner can withdraw available funding only after the opportunity closes.");
    amountBaseUnits = positiveUnits(options.amountBaseUnits);
    if (action === "withdraw" && BigInt(amountBaseUnits) > BigInt(summary.available)) fail("failed-precondition", "The withdrawal exceeds the unreserved pool balance.");
    functionName = action === "deposit" ? "deposit" : "withdrawAvailable"; args = [amountBaseUnits];
  } else if (["select", "accept", "void"].includes(action)) {
    if (!summary.exists) fail("failed-precondition", "Create and deposit into the grant pool first.");
    const context = await loadFundingContext({ db, uid, proposalId });
    if (context.record.problemId !== problemId) fail("failed-precondition", "This proposal belongs to another opportunity.");
    const expected = prepareStoredProposal(context.record, { registryConfig: config });
    const blockNumber = BigInt(summary.blockNumber), readContract = request => client.readContract({ ...request, blockNumber });
    const [escrow, proposal, offer] = await Promise.all([
      verifyProposalEscrow({ expected, config, readContract }),
      readContract({ address: config.address, abi: config.abi, functionName: "getProposal", args: [expected.entityId] }),
      readContract({ address, abi: config.escrow.openFundingPoolAbi, functionName: "getOffer", args: [expected.entityId] }),
    ]);
    if (!same(at(proposal, "researcher", 0), expected.expectedResearcher) || !same(at(proposal, "opportunityId", 1), expected.opportunityId)
        || !same(at(proposal, "proposalHash", 4), expected.proposalHash) || !same(at(proposal, "solutionHash", 5), expected.solutionHash)) fail("failed-precondition", "The proposal differs from its verified registry content.");
    const [linkedPool, actionState] = await Promise.all([
      readContract({ address: escrow.address, abi: config.escrow.escrowAbi, functionName: "openFundingPool" }),
      action === "select"
        ? readContract({ address: escrow.address, abi: config.escrow.escrowAbi, functionName: "totalDeposited" })
        : readContract({ address: config.address, abi: config.abi, functionName: action === "accept" ? "isFundingActive" : "isFundingInvalidated", args: [expected.entityId, escrow.address] }),
    ]);
    if (!same(linkedPool, summary.poolAddress) || !same(expected.fundingTerms.token, summary.tokenAddress)) fail("failed-precondition", "The proposal's escrow is not linked to this grant pool and token.");
    const state = Number(at(offer, "state", 2)), deadline = BigInt(at(offer, "acceptanceDeadline", 1));
    if (action === "select") {
      if (!summary.canSelect || hidden(context.record) || !["submitted", "under_review"].includes(context.record.status) || state !== 0) fail("permission-denied", "Only the owner can select an eligible proposal from available grant funding.");
      const deposited = actionState;
      if (deposited !== 0n || expected.fundingTerms.target > BigInt(summary.available)) fail("failed-precondition", "The requested grant must fit the available pool balance and its proposal escrow must be empty.");
      functionName = "selectProposal";
    } else if (action === "accept") {
      if (!same(uid, context.record.researcherId)) fail("permission-denied", "Only the selected proposal owner can accept the grant.");
      const active = actionState;
      if (state !== 1 || deadline <= BigInt(summary.timestamp) || !active || summary.withdrawn || summary.paused || hidden(context.record) || hidden(context.parent)) fail("failed-precondition", "The seven-day grant acceptance window has closed or this selection is inactive.");
      functionName = "acceptProposal";
    } else {
      const invalidated = actionState;
      if (state !== 1 || (deadline > BigInt(summary.timestamp) && !invalidated)) fail("failed-precondition", "The selected proposal can be voided after its acceptance deadline or the opportunity is invalidated.");
      functionName = "expireProposal";
    }
    args = [expected.entityId];
  } else fail("invalid-argument", "Choose a valid grant action.");
  const abi = contractType === "factory" ? config.escrow.factoryAbi : config.escrow.openFundingPoolAbi;
  const data = encodeFunctionData({ abi, functionName, args });
  let approvalRequired = false;
  if (functionName === "deposit") {
    const blockNumber = BigInt(summary.blockNumber);
    const readToken = (functionName, args = []) => client.readContract({ address: token.tokenAddress, abi: erc20Abi, functionName, args, blockNumber });
    const [balance, allowance, decimals, allowed] = await Promise.all([
      readToken("balanceOf", [uid]), readToken("allowance", [uid, address]), readToken("decimals"),
      client.readContract({ address: config.escrow.factoryAddress, abi: config.escrow.factoryAbi,
        functionName: "allowedTokens", args: [token.tokenAddress], blockNumber }),
    ]);
    if (!allowed || Number(decimals) !== token.tokenDecimals) fail("failed-precondition", "The grant token is no longer supported with its original precision.");
    if (BigInt(balance) < BigInt(amountBaseUnits)) fail("failed-precondition", `Your ${token.tokenSymbol} balance is too low for that deposit.`);
    approvalRequired = BigInt(allowance) < BigInt(amountBaseUnits);
  }
  // A first deposit must be prepared before the owner can approve this pool.
  // Simulating transferFrom at zero allowance would prevent that approval flow.
  // The wallet executes the deposit after approval and the contract rechecks
  // ownership, token terms, balance and exact movement atomically.
  if (!approvalRequired) await client.simulateContract({ address, abi, functionName,
    args: args.map((arg, i) => (functionName === "deposit" || functionName === "withdrawAvailable") && i === 0 ? BigInt(arg) : arg), account: uid });
  const request = { address: address.toLowerCase(), functionName, args };
  return { ...request, request, contractType, data, chainId: config.chainId, ...token, poolAddress: summary.poolAddress,
    ...(functionName === "deposit" ? { approvalRequired } : {}),
    ...(amountBaseUnits ? { amountBaseUnits } : {}) };
}

export async function syncOpenFunding(options) {
  options = { ...options, client: createRequestReadClient(options.client, { chainId: options.config.chainId }) };
  const { db, client, config, uid, problemId, transactionHash, now = Timestamp.now() } = options;
  if (!supportsOpenFunding(config)) fail("failed-precondition", "Open funding grants require the updated smart contracts and deployment manifest. This deployment is read-only for grants.");
  if (transactionHash !== undefined && !/^0x[0-9a-f]{64}$/i.test(transactionHash)) fail("invalid-argument", "A valid transaction hash is required.");
  const summary = await readOpenFunding(options);
  if (transactionHash) {
    const receipt = await client.getTransactionReceipt({ hash: transactionHash });
    if (receipt.status === "success" && same(receipt.transactionHash, transactionHash)
        && typeof receipt.blockNumber === "bigint" && receipt.blockNumber > BigInt(summary.blockNumber)) {
      fail("unavailable", "The grant transaction is mined and awaiting another chain confirmation. Check this transaction again shortly.");
    }
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const relevant = receipt.logs.some(log => {
      const abi = same(log.address, config.escrow.factoryAddress) ? config.escrow.factoryAbi
        : summary.poolAddress && same(log.address, summary.poolAddress) ? config.escrow.openFundingPoolAbi : null;
      if (!abi) return false;
      try { const decoded = decodeEventLog({ abi, topics: log.topics, data: log.data, strict: true });
        return same(log.address, summary.poolAddress) || same(decoded.args.postingId, summary.postingId); } catch { return false; }
    });
    if (receipt.status !== "success" || !same(receipt.transactionHash, transactionHash)
        || !same(receipt.blockHash, block.hash) || !relevant) fail("failed-precondition", "This transaction has no confirmed action for the canonical grant pool.");
  }
  await saveOpenFundingSnapshot({ db, config, summary, now });
  const { selections } = summary;
  for (const selection of selections) {
    if (selection.status === "accepted") {
      const proposalRef = db.collection("proposals").doc(selection.proposalId);
      await db.runTransaction(async tx => {
        const proposal = await tx.get(proposalRef);
        if (proposal.exists && proposal.data().problemId === problemId && ["submitted", "under_review"].includes(proposal.data().status)) {
          tx.update(proposalRef, { status: "accepted", updatedAt: now });
        }
      });
      const proposal = await proposalRef.get();
      if (proposal.exists) await enqueueEscrowFunding({ db, config, record: { ...proposal.data(), id: selection.proposalId }, now });
    }
    if (selection.status !== "pending") continue;
    const id = `grant_${deploymentKey(config)}_${selection.entityId}_${selection.acceptanceDeadline}_${selection.researcherId}`;
    const ref = db.collection("moderationNotifications").doc(id);
    await db.runTransaction(async tx => {
      if ((await tx.get(ref)).exists) return;
      tx.set(ref, memberNoticeFields({ recipientId: selection.researcherId, now, createdAt: now, kind: "open_funding_selection",
        contentType: "proposal", contentId: selection.proposalId, problemId, proposalId: selection.proposalId,
        title: "Grant selected — accept within seven days", message: `Your proposal “${selection.title}” has been selected for grant funding. Accept it before the seven-day deadline.` }));
    });
  }
  return summary;
}
