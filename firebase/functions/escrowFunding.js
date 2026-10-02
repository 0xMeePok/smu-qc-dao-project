import { randomUUID } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { encodeFunctionData, keccak256, stringToHex } from "viem";
import { prepareStoredProposal } from "./proposalAuditPayload.js";
import { opportunityEntityId } from "./auditCanonical.js";
import { verifyProposalEscrow } from "./escrowAudit.js";
import { canReadContent, memberNoticeFields } from "./moderation.js";
import { ESCROW_STATES, milestoneValue, reconcileFundingReceipt, same } from "./escrowFundingEvents.js";

export const FUNDING_JOBS = "escrowFundingJobs", FUNDING_SUMMARIES = "escrowFundingSummaries";
export const FUNDING_EVENTS = "escrowFundingEvents", PLATFORM_OUTBOX = "escrowPlatformOutbox", PAUSE_JOBS = "escrowPostingPauseJobs";
const ZERO = `0x${"0".repeat(64)}`, BLOCK_SPAN = 10_000n, TX_PAGE = 15;
const validId = id => { if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new HttpsError("invalid-argument", "A valid proposal reference is required."); };
const fail = (code, message) => { throw new HttpsError(code, message); };
const at = (value, name, index) => value?.[name] ?? value?.[index];
const millis = value => value?.toMillis?.() ?? 0;
const timestamp = ms => Timestamp.fromMillis(ms);
const blocked = data => data?.moderated || ["hidden", "removed"].includes(data?.moderationStatus);
const desiredPostingPause = data => Boolean(blocked(data) || ["withdrawn", "cancelled", "draft"].includes(data?.status));
export const deploymentKey = config => `${config.chainId}_${config.address.toLowerCase()}`;
const isOpenFunding = (record, parent) => record?.opportunityType === "open-funding" || parent?.opportunityType === "open-funding";
const hasRegistryFunction = (config, name) => config.abi?.some(item => item.type === "function" && item.name === name);
const jobKey = (config, id) => `${deploymentKey(config)}_${id}`;
const publicSettlement = job => job?.settlement ?? { status: "waiting", message: "Waiting for the selected proposal and both owners' approvals." };
const safeMessage = error => error instanceof HttpsError ? error.message
  : /mismatch/i.test(error?.message || "") ? "Escrow reconciliation found a mismatch. An administrator must review the receipt."
    : "Escrow confirmation is temporarily unavailable. The same transaction will be retried.";

export async function assertFundingChain(client, config) {
  if (config?.chainId !== 421614 || config?.contractName !== "EscrowAuditRegistry" || await client.getChainId() !== 421614) {
    fail("failed-precondition", "Escrow funding is available only on the configured Arbitrum Sepolia deployment.");
  }
  const required = ["acceptedProposalForPosting", "postingFundingPaused", "setPostingFundingPaused", "isFundingInvalidated"];
  if (required.some(name => !config.abi?.some(item => item.type === "function" && item.name === name))) {
    fail("failed-precondition", "Redeploy the current escrow contracts and update the deployment manifest before enabling automatic settlement.");
  }
}

export async function loadFundingContext({ db, proposalId, uid }) {
  validId(proposalId);
  const proposal = await db.collection("proposals").doc(proposalId).get();
  if (!proposal.exists) fail("not-found", "This proposal is no longer available.");
  const record = { ...proposal.data(), id: proposalId };
  if (uid) {
    const profile = await db.collection("users").doc(uid).get();
    if (!profile.exists || profile.data().suspended
        || !await canReadContent({ get: ref => ref.get() }, db, "proposal", record, uid, profile.data())) {
      fail("permission-denied", "This proposal is not available to your account.");
    }
  }
  validId(record.problemId);
  const parent = await db.collection("problems").doc(record.problemId).get();
  if (!parent.exists || !same(parent.data().ownerId, record.postingOwnerId)) fail("failed-precondition", "The proposal's posting ownership cannot be verified.");
  return { record, parent: { ...parent.data(), id: parent.id } };
}

export function fundingBlockReason(record, parent, chain, now = Date.now(), { deposit = false } = {}) {
  if (blocked(parent) || blocked(record)) return "Funding is paused while this content is moderated.";
  if (["draft", "withdrawn", "cancelled", "rejected"].includes(record.status)
      || ["draft", "withdrawn", "cancelled"].includes(parent.status)) return "This posting or proposal is no longer eligible for funding.";
  const accepted = isOpenFunding(record, parent) ? null : parent.acceptedProposalId || parent.escrowSelection?.proposalId;
  if (accepted && accepted !== record.id) return "A different proposal has been selected for this posting.";
  if (!isOpenFunding(record, parent) && parent.acceptedSolutionId && parent.acceptedSolutionId !== record.id) return "This posting already has an accepted solution.";
  if (deposit && isOpenFunding(record, parent)) return "Open funding is deposited by its owner into the grant pool. Use the grant workflow for this proposal.";
  if (!isOpenFunding(record, parent) && chain?.pendingProposalEntityId && !same(chain.pendingProposalEntityId, ZERO)
      && !same(chain.pendingProposalEntityId, chain.proposalEntityId)) return "A different proposal is awaiting owner acceptance for this posting.";
  if (chain && !chain.active) return "The on-chain posting or proposal is inactive or paused.";
  if (deposit && (! ["submitted", "open"].includes(parent.status)
      || !["submitted", "under_review"].includes(record.status)
      || (millis(parent.expiresAt) && millis(parent.expiresAt) <= now))) return "This posting's funding window is closed.";
  if (deposit && chain && (chain.state !== "Open" || BigInt(chain.expiresAt) * 1000n <= BigInt(now))) return "The escrow is no longer accepting deposits.";
  if (deposit && chain && BigInt(chain.totalDeposited) >= BigInt(chain.fundingTarget)) return "The proposal is fully funded.";
  return null;
}

/** Every read used in a projection is pinned to one confirmed block. */
export async function readVerifiedFunding({ client, config, record, parent, blockNumber }) {
  const expected = prepareStoredProposal(record, { registryConfig: config });
  const read = request => client.readContract({ ...request, blockNumber });
  const [proposal, escrow] = await Promise.all([
    read({ address: config.address, abi: config.abi, functionName: "getProposal", args: [expected.entityId] }),
    verifyProposalEscrow({ expected, config, readContract: read }),
  ]);
  if (!same(at(proposal, "researcher", 0), expected.expectedResearcher)
      || !same(at(proposal, "opportunityId", 1), expected.opportunityId)
      || !same(at(proposal, "proposalHash", 4), expected.proposalHash)
      || !same(at(proposal, "solutionHash", 5), expected.solutionHash)) {
    throw new Error("Escrow reconciliation mismatch: proposal content differs from its registry hashes.");
  }
  const names = ["state", "totalDeposited", "totalReleased", "totalRefunded", "outstandingBalance", "currentTranche",
    "selectionId", "ownerApproved", "solutionApproved", "yesWeight", "approvalDeadline", "expiresAt", "platformSigner"];
  const values = await Promise.all(names.map(functionName => read({ address: escrow.address, abi: config.escrow.escrowAbi, functionName })));
  const data = Object.fromEntries(names.map((name, i) => [name, values[i]]));
  const [active, invalidated, count, pendingProposalEntityId, block] = await Promise.all([
    read({ address: config.address, abi: config.abi, functionName: "isFundingActive", args: [expected.entityId, escrow.address] }),
    read({ address: config.address, abi: config.abi, functionName: "isFundingInvalidated", args: [expected.entityId, escrow.address] }),
    read({ address: config.address, abi: config.abi, functionName: "fundingAnchorCount", args: [expected.entityId] }),
    !isOpenFunding(record, parent) && hasRegistryFunction(config, "pendingProposalForPosting")
      ? read({ address: config.address, abi: config.abi, functionName: "pendingProposalForPosting", args: [expected.opportunityId] }) : null,
    client.getBlock({ blockNumber }),
  ]);
  if (typeof block?.timestamp !== "bigint" || block.timestamp < 0n || block.timestamp > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))) {
    throw new Error("Escrow reconciliation mismatch: confirmed block time cannot be verified.");
  }
  const milestones = await Promise.all(expected.fundingTerms.trancheBps.map((_, index) => read({ address: escrow.address,
    abi: config.escrow.escrowAbi, functionName: "milestoneAt", args: [BigInt(index)] })));
  const token = config.escrow.tokens.find(item => same(item.address, expected.fundingTerms.token));
  const summary = { proposalId: record.id, problemId: record.problemId, title: record.title || "Proposal", postingTitle: parent.title || "Posting",
    postingOwnerId: parent.ownerId, researcherId: record.researcherId, registryAddress: config.address.toLowerCase(),
    escrowAddress: escrow.address, tokenAddress: token.address.toLowerCase(), tokenSymbol: token.symbol, tokenDecimals: token.decimals,
    chainId: config.chainId, state: ESCROW_STATES[Number(data.state)], totalDeposited: String(data.totalDeposited),
    totalReleased: String(data.totalReleased), totalRefunded: String(data.totalRefunded), outstandingBalance: String(data.outstandingBalance),
    fundingTarget: expected.fundingTerms.target.toString(), expiresAt: String(data.expiresAt),
    upfrontReleased: milestoneValue(milestones[0], "paid", 6) === true,
    finalReleased: milestoneValue(milestones.at(-1), "paid", 6) === true, active, invalidated,
    proposalEntityId: expected.entityId, pendingProposalEntityId,
    timestamp: Number(block.timestamp), blockNumber: Number(blockNumber), currentTranche: Number(data.currentTranche) };
  summary.fundingBlockReason = fundingBlockReason(record, parent, summary, summary.timestamp * 1000, { deposit: true });
  return { expected, escrow, data, summary, milestones, anchorCount: Number(count) };
}

export async function enqueueEscrowFunding({ db, config, record, now = Timestamp.now() }) {
  if (!record?.id || !record.fundingTerms || record.audit?.status !== "confirmed") return;
  const ref = db.collection(FUNDING_JOBS).doc(jobKey(config, record.id));
  await db.runTransaction(async tx => {
    const old = await tx.get(ref);
    if (old.exists) return;
    tx.set(ref, { proposalId: record.id, registryAddress: config.address.toLowerCase(), nextAttemptAt: now,
      cursorBlock: null, anchorCount: 0, status: "pending", updatedAt: now });
  });
}

async function saveEvent({ db, event, record, summary, now }) {
  const ref = db.collection(FUNDING_EVENTS).doc(event.id), audit = db.collection("audits").doc(`escrow_${event.id}`);
  const recipients = [...new Set([record.researcherId, record.postingOwnerId])];
  await db.runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (existing.exists) return;
    const notices = event.eventType === "TrancheReleased"
      ? recipients.map(uid => db.collection("moderationNotifications").doc(`${event.id}_${uid}`)) : [];
    const oldNotices = await Promise.all(notices.map(item => tx.get(item)));
    const item = { ...event, proposalId: record.id, problemId: record.problemId,
      tokenSymbol: summary.tokenSymbol, tokenDecimals: summary.tokenDecimals };
    const eventAt = timestamp(event.timestamp * 1000);
    tx.set(ref, item);
    tx.set(audit, { ...item, type: "escrow", action: `ESCROW_${event.eventType.toUpperCase()}`, title: record.title,
      targetId: record.id, timestamp: eventAt, createdAt: now });
    notices.forEach((notice, i) => {
      if (oldNotices[i].exists) return;
      tx.set(notice, { ...memberNoticeFields({ recipientId: recipients[i], now, createdAt: eventAt, kind: "escrow",
        contentType: "proposal", contentId: record.id, proposalId: record.id, problemId: record.problemId,
        title: event.tranche === 0 ? "Upfront escrow payment released" : "Final escrow payment released",
        message: `${event.tranche === 0 ? "The upfront" : "The final"} payment for “${record.title}” is confirmed on Arbitrum Sepolia.`,
      }), eventId: event.id, transactionHash: event.transactionHash, registryAddress: event.registryAddress });
    });
  });
}

async function initialBlock(record, client, config) {
  const receipt = await client.getTransactionReceipt({ hash: record.audit?.transactionHash });
  if (receipt.status !== "success" || !same(receipt.to, config.address)) fail("failed-precondition", "This proposal belongs to a different or unconfirmed registry deployment.");
  // audit.transactionHash may be a later updateHashes receipt. Creation is
  // immutable, so begin at the deployment checkpoint and scan bounded pages.
  return BigInt(config.deployment?.blockNumber ?? 0);
}

export async function getEscrowFundingHistory({ db, config, uid, proposalId }) {
  const { record, parent } = await loadFundingContext({ db, proposalId, uid });
  const key = jobKey(config, proposalId);
  const [events, saved, job] = await Promise.all([
    db.collection(FUNDING_EVENTS).where("proposalId", "==", proposalId).where("registryAddress", "==", config.address.toLowerCase())
      .orderBy("blockNumber", "desc").orderBy("logIndex", "desc").limit(100).get(),
    db.collection(FUNDING_SUMMARIES).doc(key).get(), db.collection(FUNDING_JOBS).doc(key).get(),
  ]);
  const summary = saved.exists ? { ...saved.data(), fundingBlockReason: fundingBlockReason(record, parent, saved.data(), Date.now(), { deposit: true }) } : null;
  return { events: events.docs.map(doc => doc.data()), hasMore: events.size === 100, summary,
    reconciliation: job.data()?.reconciliation ?? { status: "syncing", matched: false, complete: false },
    settlement: publicSettlement(job.data()) };
}

export async function prepareEscrowDeposit({ db, client, config, uid, proposalId }) {
  await assertFundingChain(client, config);
  const context = await loadFundingContext({ db, uid, proposalId });
  if (isOpenFunding(context.record, context.parent)) fail("failed-precondition", "Open funding is deposited by its owner into the grant pool. Use the grant workflow for this proposal.");
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const verified = await readVerifiedFunding({ client, config, ...context, blockNumber });
  const reason = fundingBlockReason(context.record, context.parent, verified.summary, verified.summary.timestamp * 1000, { deposit: true });
  if (reason) fail("failed-precondition", reason);
  await enqueueEscrowFunding({ db, config, record: context.record });
  return { escrowAddress: verified.escrow.address, tokenAddress: verified.summary.tokenAddress, chainId: config.chainId,
    postingId: verified.expected.opportunityId, postingOwner: context.parent.ownerId, terms: context.record.fundingTerms,
    remainingBaseUnits: (BigInt(verified.summary.fundingTarget) - BigInt(verified.summary.totalDeposited)).toString() };
}

/** Exactly one signed transaction may be outstanding for this deployment's
 * platform wallet. Persist bytes and hash before broadcasting; a crash retries
 * those exact bytes, never a fresh transaction or a different recipient. */
export async function submitPlatformAction({ db, client, config, getWallet, action, now = Timestamp.now() }) {
  const ref = db.collection(PLATFORM_OUTBOX).doc(deploymentKey(config)), token = randomUUID();
  const claimed = await db.runTransaction(async tx => {
    const row = await tx.get(ref), old = row.data() || {};
    if (action.pauseRevision) {
      const [pause, parent] = await Promise.all([
        tx.get(db.collection(PAUSE_JOBS).doc(jobKey(config, action.problemId))),
        tx.get(db.collection("problems").doc(action.problemId)),
      ]);
      if (pause.data()?.revision !== action.pauseRevision || pause.data()?.status !== "pending"
          || !parent.exists || desiredPostingPause(parent.data()) !== action.args[1]) return { superseded: true };
    }
    if (old.transactionHash) return { existing: old };
    if (millis(old.leaseUntil) > now.toMillis()) return { busy: true };
    tx.set(ref, { ...old, problemId: action.problemId || null, proposalId: action.proposalId || null,
      actionKey: action.key, leaseToken: token, leaseUntil: timestamp(now.toMillis() + 120_000), status: "preparing" });
    return { acquired: true };
  });
  if (claimed.superseded) return { status: "superseded", message: "A newer posting update replaced this action." };
  if (claimed.busy) return { status: "queued", message: "The platform signer is processing another confirmed action." };
  if (claimed.existing) {
    await resumePlatformTransaction({ db, client, config, now });
    return claimed.existing.actionKey === action.key
      ? { status: "pending", transactionHash: claimed.existing.transactionHash, message: "A signed platform transaction is awaiting confirmation." }
      : { status: "queued", message: "The platform signer is confirming another action before this payment." };
  }
  try {
    await assertFundingChain(client, config);
    const wallet = await getWallet();
    const signer = await client.readContract({ address: config.escrow.factoryAddress, abi: config.escrow.factoryAbi, functionName: "platformSigner" });
    if (!same(wallet.account.address, signer)) fail("failed-precondition", "The configured platform signer does not match this deployment.");
    await client.simulateContract({ address: action.address, abi: action.abi, functionName: action.functionName,
      args: action.args, account: wallet.account });
    const nonce = await client.getTransactionCount({ address: wallet.account.address, blockTag: "pending" });
    const prepared = await wallet.prepareTransactionRequest({ account: wallet.account, to: action.address,
      data: encodeFunctionData(action), nonce, chain: wallet.chain });
    const serializedTransaction = await wallet.signTransaction(prepared);
    const transactionHash = keccak256(serializedTransaction);
    await db.runTransaction(async tx => {
      const row = await tx.get(ref);
      if (row.data()?.leaseToken !== token || row.data()?.transactionHash) fail("aborted", "The signer lease changed. Retry the same action.");
      tx.set(ref, { proposalId: action.proposalId || null, problemId: action.problemId || null, actionKey: action.key,
        functionName: action.functionName, transactionHash, serializedTransaction, nonce,
        signerAddress: wallet.account.address.toLowerCase(), status: "pending", createdAt: now,
        registryAddress: config.address.toLowerCase(), leaseUntil: timestamp(0) });
    });
    // RPC errors can occur after accepting a transaction. Preserve the outbox in
    // every case; the scheduler checks its hash and rebroadcasts identical bytes.
    try { await client.sendRawTransaction({ serializedTransaction }); } catch { /* durable retry */ }
    return { status: "pending", transactionHash, message: "Platform transaction submitted; confirmation will continue in the background." };
  } catch (error) {
    await db.runTransaction(async tx => {
      const row = await tx.get(ref);
      if (row.data()?.leaseToken === token && !row.data()?.transactionHash) tx.set(ref, { status: "idle", leaseUntil: timestamp(0) });
    });
    throw error;
  }
}

export async function resumePlatformTransaction({ db, client, config, now = Timestamp.now() }) {
  const ref = db.collection(PLATFORM_OUTBOX).doc(deploymentKey(config)), pending = (await ref.get()).data();
  if (!pending?.transactionHash) return { status: "idle" };
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash: pending.transactionHash }); } catch { /* not mined */ }
  const head = await client.getBlockNumber({ cacheTime: 0 });
  if (!receipt || receipt.blockNumber + 1n > head) {
    if (!receipt && pending.signerAddress && Number.isInteger(pending.nonce)) {
      const confirmedNonce = await client.getTransactionCount({ address: pending.signerAddress, blockNumber: head - 1n });
      if (confirmedNonce > pending.nonce) {
        await db.runTransaction(async tx => {
          const current = await tx.get(ref);
          if (current.data()?.transactionHash === pending.transactionHash) tx.set(ref, {
            status: "idle", lastTransactionHash: pending.transactionHash, lastActionKey: pending.actionKey,
            lastOutcome: "replaced", updatedAt: now, leaseUntil: timestamp(0),
          });
        });
        return { status: "replaced", transactionHash: pending.transactionHash };
      }
    }
    try { await client.sendRawTransaction({ serializedTransaction: pending.serializedTransaction }); } catch { /* same hash retry */ }
    return { status: "pending", transactionHash: pending.transactionHash };
  }
  const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (!same(receipt.blockHash, canonical.hash)) return { status: "pending", transactionHash: pending.transactionHash };
  await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (current.data()?.transactionHash !== pending.transactionHash) return;
    const jobRef = pending.proposalId ? db.collection(FUNDING_JOBS).doc(jobKey(config, pending.proposalId)) : null;
    const job = jobRef ? await tx.get(jobRef) : null;
    tx.set(ref, { status: "idle", lastTransactionHash: pending.transactionHash,
      lastActionKey: pending.actionKey, lastOutcome: receipt.status, updatedAt: now, leaseUntil: timestamp(0) });
    if (job?.exists) tx.set(jobRef, { ...job.data(), nextAttemptAt: now, updatedAt: now, settlement: {
      status: receipt.status === "success" ? "confirmed" : "failed", transactionHash: pending.transactionHash,
      message: receipt.status === "success" ? "Platform transaction confirmed; reconciling funding events." : "The platform transaction reverted; the confirmed escrow state will be checked again.",
    } });
  });
  return { status: receipt.status, transactionHash: pending.transactionHash };
}

export function settlementAction({ verified, config, record, parent, job, now }) {
  const { data, expected, summary, milestones, escrow } = verified;
  const base = { address: escrow.address, abi: config.escrow.escrowAbi, proposalId: record.id };
  const chainMillis = summary.timestamp * 1000;
  if (["Open", "Locked", "Active"].includes(summary.state) && summary.invalidated) {
    return { action: { ...base, key: `refund-invalidated:${record.id}`, functionName: "refundInvalidated", args: [] } };
  }
  const deadline = summary.state === "Active" || (summary.state === "Locked"
    && (isOpenFunding(record, parent) || hasRegistryFunction(config, "pendingProposalForPosting")))
    ? BigInt(data.approvalDeadline) : BigInt(data.expiresAt);
  if (["Open", "Locked", "Active"].includes(summary.state) && !(summary.state === "Open" && isOpenFunding(record, parent))
      && deadline * 1000n <= BigInt(chainMillis)) {
    return { action: { ...base, key: `expire:${record.id}:${data.currentTranche}:${deadline}`, functionName: "expire", args: [] } };
  }
  const reason = fundingBlockReason(record, parent, summary, chainMillis);
  if (reason) return { settlement: { status: "blocked", message: reason } };
  if (!isOpenFunding(record, parent) && summary.state === "Open" && job.selectionRequested && !fundingBlockReason(record, parent, summary, chainMillis, { deposit: false })
      && BigInt(summary.totalDeposited) === BigInt(summary.fundingTarget) && BigInt(data.expiresAt) * 1000n > BigInt(chainMillis)) {
    return { action: { ...base, key: `select:${record.id}:${job.selectionId}`, functionName: "lockSelection",
      args: [job.selectionId, expected.expectedResearcher] } };
  }
  if (!["Locked", "Active"].includes(summary.state)) return { settlement: { status: summary.state === "Released" ? "complete" : "waiting",
    message: summary.state === "Released" ? "Both escrow payments are confirmed." : isOpenFunding(record, parent)
      ? summary.state === "Open" ? "Grant funding moves into this escrow when the researcher accepts the selected offer." : `The grant escrow is ${summary.state.toLowerCase()}.`
      : "The posting owner must select the fully funded proposal." } };
  if (BigInt(data.approvalDeadline) * 1000n <= BigInt(chainMillis)) return { settlement: { status: "blocked", message: "The approval window has elapsed." } };
  if (!data.ownerApproved || !data.solutionApproved) return { settlement: { status: "awaiting-approvals", message: "Both owners must approve the current payment." } };
  const index = Number(data.currentTranche), milestone = milestones[index];
  if (index > 0 && expected.fundingTerms.funderVoting && BigInt(data.yesWeight) <= BigInt(summary.totalDeposited) / 2n) {
    return { settlement: { status: "awaiting-votes", message: "Both owners approved; the configured funder majority is still required." } };
  }
  const evidence = milestoneValue(milestone, "evidenceHash", 4);
  if (!milestone || milestoneValue(milestone, "paid", 6) || (index > 0 && same(evidence, ZERO))) return { settlement: { status: "waiting", message: "The current milestone needs evidence." } };
  return { action: { ...base, key: `release:${record.id}:${data.selectionId}:${index}:${evidence}`,
    functionName: index === 0 ? "release" : "releaseMilestone",
    args: index === 0 ? [data.selectionId] : [data.selectionId, BigInt(index), evidence] } };
}

export async function syncEscrowFunding({ db, client, config, getWallet, uid, proposalId, transactionHash, now = Timestamp.now() }) {
  await assertFundingChain(client, config);
  if (transactionHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) fail("invalid-argument", "A valid transaction hash is required.");
  const context = await loadFundingContext({ db, uid, proposalId });
  await enqueueEscrowFunding({ db, config, record: context.record, now });
  const ref = db.collection(FUNDING_JOBS).doc(jobKey(config, proposalId)), leaseToken = randomUUID();
  const job = await db.runTransaction(async tx => {
    const row = await tx.get(ref);
    if (!row.exists) fail("failed-precondition", "Confirm the proposal's registry receipt before funding it.");
    if (millis(row.data().leaseUntil) > now.toMillis()) return null;
    tx.set(ref, { ...row.data(), leaseToken, leaseUntil: timestamp(now.toMillis() + 180_000) });
    return row.data();
  });
  if (!job) return getEscrowFundingHistory({ db, config, uid, proposalId });
  try {
    const head = await client.getBlockNumber({ cacheTime: 0 }), safeBlock = head - 1n;
    const fromBlock = job.cursorBlock == null ? await initialBlock(context.record, client, config) : BigInt(job.cursorBlock) + 1n;
    if (job.cursorBlock != null) {
      const previous = await client.getBlock({ blockNumber: BigInt(job.cursorBlock) });
      if (!same(previous.hash, job.cursorHash)) throw new Error("Escrow reconciliation mismatch: the saved checkpoint was reorganized.");
    }
    const toBlock = fromBlock + BLOCK_SPAN - 1n < safeBlock ? fromBlock + BLOCK_SPAN - 1n : safeBlock;
    const verified = await readVerifiedFunding({ client, config, ...context, blockNumber: safeBlock });
    const event = config.abi.find(item => item.type === "event" && item.name === "FundingEventAnchored");
    const logs = fromBlock <= toBlock ? await client.getLogs({ address: config.address, event,
      args: { proposalId: verified.expected.entityId, escrow: verified.escrow.address }, fromBlock, toBlock, strict: true }) : [];
    const hashes = [...new Set(logs.map(log => log.transactionHash))];
    // Stop at a complete receipt boundary and persist the block cursor. Never
    // skip a receipt when a busy proposal exceeds this invocation's budget.
    const pageHashes = hashes.slice(0, TX_PAGE);
    let cursorBlock = toBlock;
    if (hashes.length > TX_PAGE) {
      cursorBlock = logs.find(log => same(log.transactionHash, hashes[TX_PAGE])).blockNumber - 1n;
    }
    const selected = pageHashes.filter(hash => logs.find(log => same(log.transactionHash, hash)).blockNumber <= cursorBlock);
    if (hashes.length > TX_PAGE && cursorBlock < fromBlock) fail("resource-exhausted", "A single block exceeds the escrow reconciliation budget; administrator review is required.");
    let added = 0, lastHash = job.lastTransactionHash || null, selectionConsumed = false;
    const invalidatedSelections = new Set();
    for (const hash of selected) {
      const events = await reconcileFundingReceipt({ client, config, expected: verified.expected,
        escrowAddress: verified.escrow.address, transactionHash: hash, safeBlock });
      for (const item of events) {
        await saveEvent({ db, event: item, record: context.record, summary: verified.summary, now });
        if (["SelectionLocked", "SelectionInvalidated"].includes(item.eventType) && same(item.selectionId, job.selectionId)) selectionConsumed = true;
        if (item.eventType === "SelectionInvalidated") invalidatedSelections.add(item.selectionId);
      }
      added += events.length;
      lastHash = hash;
    }
    if (transactionHash && !selected.some(hash => same(hash, transactionHash))) {
      // Validate the wallet receipt immediately, without advancing the cursor or
      // counting it twice; the sequential index will ingest it on its own page.
      await reconcileFundingReceipt({ client, config, expected: verified.expected, escrowAddress: verified.escrow.address, transactionHash, safeBlock });
    }
    const complete = cursorBlock === safeBlock, anchorCount = (job.anchorCount || 0) + added;
    if (complete && anchorCount !== verified.anchorCount) throw new Error("Escrow reconciliation mismatch: indexed anchor count differs from the registry.");
    const cursor = await client.getBlock({ blockNumber: cursorBlock });
    const reconciliation = { status: complete ? "verified" : "syncing", matched: complete, complete, anchors: anchorCount, blockNumber: Number(cursorBlock) };
    const fresh = await loadFundingContext({ db, proposalId });
    let settlement = publicSettlement(job);
    if (complete && getWallet) {
      const decision = settlementAction({ verified, config, ...fresh,
        job: { ...job, selectionRequested: job.selectionRequested && !selectionConsumed }, now });
      settlement = decision.action ? await submitPlatformAction({ db, client, config, getWallet, action: decision.action, now }) : decision.settlement;
    }
    await db.runTransaction(async tx => {
      const current = await tx.get(ref);
      if (current.data()?.leaseToken !== leaseToken) fail("aborted", "The funding reconciliation lease changed.");
      const parentRef = db.collection("problems").doc(context.record.problemId), proposalRef = db.collection("proposals").doc(proposalId);
      const unpaidTerminal = complete && verified.summary.totalReleased === "0"
        && ["Cancelled", "Expired", "Voided", "Refunded"].includes(verified.summary.state);
      const [parent, proposal] = (complete && verified.summary.upfrontReleased) || invalidatedSelections.size || unpaidTerminal
        ? await Promise.all([tx.get(parentRef), tx.get(proposalRef)]) : [null, null];
      const terminal = ["Released", "Refunded"].includes(verified.summary.state);
      tx.set(ref, { ...current.data(), cursorBlock: Number(cursorBlock), cursorHash: cursor.hash, anchorCount,
        selectionRequested: current.data().selectionRequested === true
          && !((selectionConsumed || unpaidTerminal) && same(current.data().selectionId, job.selectionId)),
        lastTransactionHash: lastHash, reconciliation, settlement, leaseUntil: timestamp(0),
        status: terminal && complete ? "complete" : "pending", nextAttemptAt: timestamp(now.toMillis() + 60_000), updatedAt: now });
      if (complete) tx.set(db.collection(FUNDING_SUMMARIES).doc(jobKey(config, proposalId)), {
        ...verified.summary, transactionHash: lastHash, confirmedAt: now.toDate().toISOString(), reconciliation,
      });
      if (!isOpenFunding(context.record, context.parent) && complete && verified.summary.upfrontReleased && parent?.exists && parent.data().acceptedProposalId !== proposalId) {
        tx.update(parentRef, { acceptedProposalId: proposalId, hasAcceptedSolution: true, updatedAt: now });
      }
      if (complete && verified.summary.upfrontReleased && proposal?.exists && ["submitted", "under_review"].includes(proposal.data().status)) {
        tx.update(proposalRef, { status: "accepted", updatedAt: now });
      }
      if (parent?.exists && !parent.data().acceptedProposalId && verified.summary.totalReleased === "0"
          && same(parent.data().escrowSelection?.registryAddress, config.address)
          && parent.data().escrowSelection?.proposalId === proposalId
          && (invalidatedSelections.has(parent.data().escrowSelection?.selectionId)
            || (unpaidTerminal && same(parent.data().escrowSelection?.selectionId, current.data().selectionId)))) {
        tx.update(parentRef, { escrowSelection: null, updatedAt: now });
      }
    });
    return getEscrowFundingHistory({ db, config, uid, proposalId });
  } catch (error) {
    await db.runTransaction(async tx => {
      const row = await tx.get(ref);
      if (row.data()?.leaseToken !== leaseToken) return;
      tx.set(ref, { ...row.data(), leaseUntil: timestamp(0), nextAttemptAt: timestamp(now.toMillis() + 60_000),
        status: error?.code === "failed-precondition" && /different.*registry/i.test(error.message) ? "historical" : "pending",
        updatedAt: now, lastError: safeMessage(error), reconciliation: { status: "unavailable", matched: false, complete: false },
        settlement: { status: "retrying", message: safeMessage(error) } });
    });
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("unavailable", safeMessage(error));
  }
}

export async function startEscrowSettlement(options) {
  const { db, config, uid, proposalId, client, now = Timestamp.now() } = options;
  const context = await loadFundingContext({ db, uid, proposalId });
  if (isOpenFunding(context.record, context.parent)) fail("failed-precondition", "Select grant proposals from the prefunded open funding pool.");
  if (!same(context.parent.ownerId, uid)) fail("permission-denied", "Only the posting owner may select the funded proposal.");
  await assertFundingChain(client, config);
  const verified = await readVerifiedFunding({ client, config, ...context, blockNumber: await client.getBlockNumber({ cacheTime: 0 }) - 1n });
  const reason = fundingBlockReason(context.record, context.parent, verified.summary, verified.summary.timestamp * 1000);
  if (reason) fail("failed-precondition", reason);
  if (verified.summary.state !== "Open" || BigInt(verified.summary.totalDeposited) !== BigInt(verified.summary.fundingTarget)
      || BigInt(verified.summary.expiresAt) * 1000n <= BigInt(verified.summary.timestamp * 1000)) fail("failed-precondition", "Selection requires a fully funded, open escrow.");
  await enqueueEscrowFunding({ db, config, record: context.record, now });
  const ref = db.collection(FUNDING_JOBS).doc(jobKey(config, proposalId));
  await db.runTransaction(async tx => {
    const parentRef = db.collection("problems").doc(context.record.problemId), proposalRef = db.collection("proposals").doc(proposalId);
    const [parent, proposal, job] = await Promise.all([tx.get(parentRef), tx.get(proposalRef), tx.get(ref)]);
    if (!job.exists) fail("failed-precondition", "Confirm the proposal's registry receipt before selecting it.");
    const blockedReason = fundingBlockReason({ ...proposal.data(), id: proposalId }, parent.data(), verified.summary, verified.summary.timestamp * 1000);
    if (blockedReason || !same(parent.data().ownerId, uid)) fail("failed-precondition", blockedReason || "Posting ownership changed.");
    const selectionId = job.data().selectionRequested ? job.data().selectionId : keccak256(stringToHex(`${jobKey(config, proposalId)}:${randomUUID()}`));
    tx.set(ref, { ...job.data(), selectionRequested: true, selectionId, requestedBy: uid, nextAttemptAt: now, updatedAt: now });
    tx.update(parentRef, { escrowSelection: { proposalId, registryAddress: config.address.toLowerCase(), selectionId, requestedBy: uid, requestedAt: now } });
  });
  return syncEscrowFunding({ ...options, now });
}

export async function getEscrowFundingSummary({ db, client, config, uid }) {
  const sets = await Promise.all(["postingOwnerId", "researcherId"].map(field => db.collection(FUNDING_SUMMARIES)
    .where(field, "==", uid).where("registryAddress", "==", config.address.toLowerCase()).limit(50).get()));
  const unique = new Map(sets.flatMap(set => set.docs).map(doc => doc.data())
    .filter(item => item.chainId === config.chainId).map(item => [item.proposalId, item]));
  const items = [];
  if (!unique.size) return { items, truncated: false, unavailableItems: 0, blockNumber: null };
  if (config.contractName !== "EscrowAuditRegistry" || await client.getChainId() !== config.chainId) {
    fail("failed-precondition", "Payment summaries require the configured escrow chain.");
  }
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 }) - 1n;
  if (blockNumber < 0n) fail("unavailable", "No confirmed escrow block is available yet.");
  let unavailableItems = 0;
  for (const item of unique.values()) {
    let context;
    try {
      context = await loadFundingContext({ db, uid, proposalId: item.proposalId });
    } catch { /* Removed or no longer visible; do not expose a stale projection. */ }
    if (!context) continue;
    try {
      // The cache discovers authorized records. Financial values always come
      // from a fresh confirmed block; reading a dashboard never settles funds.
      const verified = await readVerifiedFunding({ client, config, ...context, blockNumber });
      items.push({ ...verified.summary });
    } catch { unavailableItems++; }
  }
  return { items, truncated: sets.some(set => set.size === 50), unavailableItems, blockNumber: Number(blockNumber) };
}

export async function queuePostingFundingPause({ db, config, problemId, record, now = Timestamp.now() }) {
  if (!record || record.status === "draft" || !record.audit?.transactionHash) return;
  const postingId = opportunityEntityId(problemId, { actor: config.entityIdScheme === 2 ? record.ownerId : undefined,
    hashScheme: record.audit?.schemaVersion ?? 1 });
  await db.collection(PAUSE_JOBS).doc(jobKey(config, problemId)).set({ problemId, postingId,
    revision: randomUUID(), registryAddress: config.address.toLowerCase(), nextAttemptAt: now, status: "pending", updatedAt: now });
}

async function updatePauseJob({ db, config, job, changes }) {
  const ref = db.collection(PAUSE_JOBS).doc(jobKey(config, job.problemId));
  await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (current.exists && current.data().revision === job.revision) tx.set(ref, { ...current.data(), ...changes });
  });
}

async function completePauseJob({ db, config, job, now }) {
  const ref = db.collection(PAUSE_JOBS).doc(jobKey(config, job.problemId));
  const outboxRef = db.collection(PLATFORM_OUTBOX).doc(deploymentKey(config));
  await db.runTransaction(async tx => {
    const [current, outbox] = await Promise.all([tx.get(ref), tx.get(outboxRef)]);
    if (!current.exists || current.data().revision !== job.revision) return;
    const pending = outbox.data();
    if (pending?.problemId === job.problemId) {
      // The present chain value can already equal the restored desired value
      // while an older opposite transaction is still in flight. Keep checking
      // until that transaction confirms; otherwise its later mining wins.
      if (pending.transactionHash || (pending.status === "preparing" && millis(pending.leaseUntil) > now.toMillis())) {
        tx.set(ref, { ...current.data(), nextAttemptAt: timestamp(now.toMillis() + 60_000), updatedAt: now });
        return;
      }
      if (pending.status === "preparing") {
        // Expire the lease atomically so an abandoned preparer cannot persist
        // and broadcast its old action after this job has completed.
        tx.set(outboxRef, { status: "idle", leaseUntil: timestamp(0), updatedAt: now });
      }
    }
    tx.set(ref, { ...current.data(), status: "complete", updatedAt: now });
  });
}

export async function reconcilePostingFundingPause({ db, client, config, getWallet, job, now = Timestamp.now() }) {
  const parent = await db.collection("problems").doc(job.problemId).get();
  if (!parent.exists) return;
  const record = parent.data(), desired = desiredPostingPause(record);
  // Never project an old posting onto a fresh deployment with a coincident ID.
  const receipt = await client.getTransactionReceipt({ hash: record.audit?.transactionHash });
  if (!same(receipt.to, config.address)) {
    await updatePauseJob({ db, config, job, changes: { status: "historical", updatedAt: now } });
    return;
  }
  const paused = await client.readContract({ address: config.address, abi: config.abi, functionName: "postingFundingPaused", args: [job.postingId] });
  if (paused === desired) {
    await completePauseJob({ db, config, job, now });
    return;
  }
  await submitPlatformAction({ db, client, config, getWallet, now, action: { address: config.address, abi: config.abi,
    functionName: "setPostingFundingPaused", args: [job.postingId, desired], problemId: job.problemId,
    pauseRevision: job.revision, key: `pause:${job.postingId}:${desired}` } });
  await updatePauseJob({ db, config, job, changes: { nextAttemptAt: timestamp(now.toMillis() + 60_000), updatedAt: now } });
}

export async function sweepEscrowFunding({ db, client, config, getWallet, now = Timestamp.now() }) {
  await assertFundingChain(client, config);
  const maintenance = await db.collection("maintenanceState").doc("registryCutover").get();
  if (maintenance.data()?.active) return { maintenance: true };
  await resumePlatformTransaction({ db, client, config, now });
  const pauses = await db.collection(PAUSE_JOBS).where("registryAddress", "==", config.address.toLowerCase()).where("status", "==", "pending").where("nextAttemptAt", "<=", now)
    .orderBy("nextAttemptAt").limit(5).get();
  for (const row of pauses.docs) {
    try { await reconcilePostingFundingPause({ db, client, config, getWallet, job: row.data(), now }); }
    catch { await updatePauseJob({ db, config, job: row.data(), changes: { nextAttemptAt: timestamp(now.toMillis() + 60_000), updatedAt: now } }); }
  }
  const jobs = await db.collection(FUNDING_JOBS).where("registryAddress", "==", config.address.toLowerCase()).where("status", "==", "pending").where("nextAttemptAt", "<=", now)
    .orderBy("nextAttemptAt").limit(10).get();
  let processed = 0;
  for (const row of jobs.docs) {
    if (!same(row.data().registryAddress, config.address)) continue;
    try { await syncEscrowFunding({ db, client, config, getWallet, proposalId: row.data().proposalId, now }); processed++; }
    catch { /* A redacted retry state was persisted by the reconciliation service. */ }
  }
  return { processed, queued: jobs.size };
}
