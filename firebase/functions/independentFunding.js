import { signalFundingChange } from "./activitySignals.js";
import { fundingAmountError, fundingTargetError } from "./fundingAmountPolicy.js";
import { boundedMap } from "./boundedMap.js";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, keccak256, parseUnits, stringToHex } from "viem";
import { prepareStoredProposal } from "./proposalAuditPayload.js";
import { verifyMinedProposal } from "./proposalAuditRecovery.js";
import { assertActiveAuditDeployment, resolveAuditDeployment } from "./auditDeployments.js";
import { canReadContent } from "./moderation.js";
import { isIndependentProposal } from "./independentProposal.js";
import { opportunityEntityId, toUnixSeconds } from "./auditCanonical.js";
import { submitPlatformAction, resumePlatformTransaction } from "./escrowFunding.js";
import { enqueueIndependentFundingCancellation, INDEPENDENT_FUNDING_CANCELLATIONS } from "./independentFundingModeration.js";

export { enqueueIndependentFundingCancellation, INDEPENDENT_FUNDING_CANCELLATIONS };
export const INDEPENDENT_FUNDING_SUMMARIES = "independentFundingSummaries";
export const INDEPENDENT_FUNDING_POSITIONS = "independentFundingPositions";
export const INDEPENDENT_FUNDING_EVENTS = "independentFundingEvents";
export const INDEPENDENT_FUNDING_JOBS = "independentFundingJobs";
export const INDEPENDENT_FUNDING_STATES = ["Open", "Accepted", "Released", "Declined", "Expired", "Cancelled", "Refunded"];
const ZERO_ADDRESS = `0x${"0".repeat(40)}`, ZERO_HASH = `0x${"0".repeat(64)}`;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const fail = (code, message) => { throw new HttpsError(code, message); };
const validAddress = value => /^0x[0-9a-f]{40}$/i.test(value ?? "") && !same(value, ZERO_ADDRESS);
const validHash = value => /^0x[0-9a-f]{64}$/i.test(value ?? "");
const blocked = record => Boolean(record.moderated || ["hidden", "removed"].includes(record.moderationStatus));
const stamp = milliseconds => Timestamp.fromMillis(milliseconds);
const safeInteger = (value, label) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail("failed-precondition", `The ${label} cannot be verified.`);
  return number;
};
const units = (value, label) => {
  try { const number = BigInt(value); if (number >= 0n) return number; } catch { /* rejected below */ }
  fail("failed-precondition", `The ${label} cannot be verified.`);
};
const serialized = value => typeof value === "bigint" ? value.toString()
  : Array.isArray(value) ? value.map(serialized) : value;
function exactAmount(value, decimals, code = "invalid-argument") {
  const text = String(value ?? "");
  if (!/^\d+(?:\.\d+)?$/.test(text) || (text.split(".")[1]?.length ?? 0) > decimals) {
    fail(code, "Enter an exact positive token amount within the currency's supported decimal places.");
  }
  return parseUnits(text, decimals);
}
const noActions = () => Object.fromEntries(["activate", "deposit", "accept", "decline", "expire", "submitEvidence", "vote", "releaseCompletion", "claimRefund"].map(action => [action, false]));

export const independentFundingKey = (config, proposalId) => `${config.chainId}_${config.address.toLowerCase()}_${proposalId}`;
export function independentFundingConfigured(config) {
  const funding = config?.independentFunding;
  return Boolean(funding?.enabled === true && validAddress(funding.factoryAddress)
    && same(funding.registryAddress, config.address) && funding.chainId === config.chainId
    && Array.isArray(funding.factoryAbi) && Array.isArray(funding.escrowAbi));
}

export function independentFundingReviewDays(record, config) {
  const windows = record.fundingTerms?.reviewWindows;
  let days = config.independentFunding.reviewDays;
  if (windows !== undefined) {
    if (!Array.isArray(windows) || windows.length < 1 || windows.length > 2) fail("failed-precondition", "The completion review window is invalid.");
    const seconds = units(windows.at(-1), "completion review window");
    if (seconds % 86400n !== 0n) fail("failed-precondition", "The completion review window must be a whole number of days.");
    days = Number(seconds / 86400n);
  }
  if (!Number.isInteger(days) || days < 1 || days > 365) fail("failed-precondition", "Configure a completion review window between 1 and 365 days.");
  return days;
}

export function normalizeIndependentFundingEvidence(evidence) {
  const summary = String(evidence?.summary ?? "").trim().normalize("NFC");
  const url = String(evidence?.url ?? "").trim();
  let parsed;
  try { parsed = new URL(url); } catch { /* rejected below */ }
  if (summary.length < 2 || summary.length > 4000 || url.length > 2048
      || !url.startsWith("https://") || parsed?.protocol !== "https:" || !parsed.hostname) {
    fail("invalid-argument", "Describe the evidence in 2–4,000 characters and provide an HTTPS evidence link.");
  }
  return { summary, url };
}
export function hashIndependentFundingEvidence(evidence) {
  return keccak256(stringToHex(JSON.stringify({ scheme: "qcdao.escrow.delivery.v1", ...normalizeIndependentFundingEvidence(evidence) })));
}

async function loadContext({ db, config, uid, proposalId }) {
  if (typeof proposalId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(proposalId)) fail("invalid-argument", "A valid independent proposal reference is required.");
  let profile = null;
  if (uid !== undefined) {
    if (!/^0x[0-9a-f]{40}$/.test(uid ?? "")) fail("permission-denied", "Sign in with an active member wallet.");
    const user = await db.collection("users").doc(uid).get();
    if (!user.exists || user.data().suspended || ![0, 1, 2, 3].includes(user.data().role)) fail("permission-denied", "An active member profile is required.");
    profile = user.data();
  }
  const proposal = await db.collection("proposals").doc(proposalId).get();
  if (!proposal.exists || !isIndependentProposal(proposal.data())) fail("not-found", "This independent proposal is not available.");
  const record = { ...proposal.data(), id: proposalId };
  const readable = uid === undefined || await canReadContent({ get: ref => ref.get() }, db, "proposal", record, uid, profile);
  if (!readable && !blocked(record)) fail("permission-denied", "This independent proposal is not available to your account.");
  return { record, profile, readable, uid, config };
}

function expectedTerms(record, config) {
  const funding = config.independentFunding;
  const token = (funding.tokens ?? config.escrow?.tokens ?? []).find(item => item.symbol === record.currency);
  if (!token || !validAddress(token.address) || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 77) {
    fail("failed-precondition", "The listing currency is not supported by this funding deployment.");
  }
  const target = exactAmount(record.amount, token.decimals, "failed-precondition");
  if (target < 2n || target >= 2n ** 256n) fail("failed-precondition", "The funding target must contain at least two token base units.");
  const prepared = prepareStoredProposal(record, { registryConfig: config });
  const expiresAt = toUnixSeconds(record.expiresAt), reviewDays = independentFundingReviewDays(record, config);
  const termsHash = keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint64" }, { type: "uint32" },
  ], [prepared.entityId, record.researcherId, token.address, target, expiresAt, reviewDays]));
  return { prepared, token, target, expiresAt, reviewDays, termsHash };
}

function frozenTerms(snapshot, record, config, entityId) {
  const token = (config.independentFunding.tokens ?? config.escrow.tokens)
    .find(item => same(item.address, snapshot.token));
  const target = units(snapshot.fundingTarget, "funding target"), expiresAt = units(snapshot.expiresAt, "listing expiry");
  const reviewDays = Number(snapshot.reviewDays);
  if (!token || !Number.isInteger(token.decimals) || token.decimals !== Number(snapshot.tokenDecimals)
      || target < 2n || target >= 2n ** 256n || !Number.isInteger(reviewDays) || reviewDays < 1 || reviewDays > 365
      || !validHash(snapshot.listingContentHash) || same(snapshot.listingContentHash, ZERO_HASH)) {
    fail("failed-precondition", "The escrow's frozen token and listing terms cannot be verified.");
  }
  const termsHash = keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint64" }, { type: "uint32" },
  ], [entityId, record.researcherId, token.address, target, expiresAt, reviewDays]));
  if (!same(termsHash, snapshot.termsHash)) fail("failed-precondition", "The escrow's frozen funding terms hash does not match.");
  return { prepared: { entityId, contentHash: snapshot.listingContentHash }, token, target, expiresAt, reviewDays, termsHash };
}

function recordFingerprint(record) {
  return JSON.stringify(Object.fromEntries(["proposalKind", "researcherId", "title", "summary", "methodology", "addressedProblems",
    "category", "maturity", "team", "amount", "currency", "expiresAt", "attachments", "fundingTerms"]
    .map(key => [key, record[key] ?? null])));
}

async function matchingEvidence({ db, record, evidenceHash }) {
  if (!validHash(evidenceHash) || same(evidenceHash, ZERO_HASH)) return null;
  const document = await db.collection("proposals").doc(record.id).collection("independentFundingEvidence").doc(evidenceHash.toLowerCase()).get();
  if (!document.exists || !same(document.data().ownerId, record.researcherId)) return null;
  try {
    const evidence = normalizeIndependentFundingEvidence(document.data());
    return same(hashIndependentFundingEvidence(evidence), evidenceHash) ? { ...evidence, hash: evidenceHash } : null;
  } catch { return null; }
}

/** One confirmed block and a fixed number of reads; never scans past logs. */
async function readState({ db, client, config, uid, proposalId, readAttachment }) {
  const context = await loadContext({ db, config, uid, proposalId });
  if (!independentFundingConfigured(config)) return { ...context, response: {
    configured: false, exists: false, hidden: !context.readable, summary: null, wallet: null, evidence: null, actions: noActions(),
  } };
  if (config.chainId !== 421614 || await client.getChainId() !== config.chainId) fail("failed-precondition", "Independent funding requires the configured Arbitrum Sepolia chain.");
  const { record } = context;
  if (record.status === "draft" || !record.audit?.transactionHash) fail("failed-precondition", "Publish and confirm this independent proposal first.");
  const deployment = await resolveAuditDeployment(record, { activeConfig: config, getTransaction: args => client.getTransaction(args) });
  assertActiveAuditDeployment(deployment, config);
  let expected, termsError;
  try { expected = expectedTerms(record, config); } catch (error) { termsError = error; }
  const entityId = opportunityEntityId(record.id, { hashScheme: 2,
    actor: config.entityIdScheme === 2 ? record.researcherId : undefined });
  const funding = config.independentFunding;
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 }) - 1n;
  if (blockNumber < 1n) fail("unavailable", "A confirmed funding block is not available yet.");
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber });
  const [registryAddress, tokenRegistry, signer, escrowAddress, opportunity, block] = await Promise.all([
    read(funding.factoryAddress, funding.factoryAbi, "auditRegistry"),
    read(funding.factoryAddress, funding.factoryAbi, "tokenRegistry"),
    read(funding.factoryAddress, funding.factoryAbi, "platformSigner"),
    read(funding.factoryAddress, funding.factoryAbi, "escrowForListing", [entityId]),
    read(config.address, config.abi, "getOpportunity", [entityId]),
    client.getBlock({ blockNumber }),
  ]);
  const field = (key, index) => opportunity[key] ?? opportunity[index];
  if (!same(registryAddress, config.address) || !same(tokenRegistry, config.escrow.factoryAddress)
      || !validAddress(signer) || !same(field("owner", 0), record.researcherId) || Number(field("kind", 1)) !== 2) {
    fail("failed-precondition", "The independent funding deployment or listing ownership does not match.");
  }
  const timestamp = safeInteger(block.timestamp, "confirmed block timestamp");
  if (same(escrowAddress, ZERO_ADDRESS)) {
    if (termsError) throw termsError;
    if (!context.readable) fail("permission-denied", "This removed listing has no refund for your wallet.");
    // Publication writes a pending receipt before its asynchronous recovery
    // trigger. Verify that receipt directly so immediate activation can proceed.
    if (uid !== undefined) await verifyMinedProposal(record, client, { registryConfig: config, readAttachment });
    const actions = noActions();
    actions.activate = same(uid, record.researcherId) && !blocked(record)
      && ["submitted", "under_review"].includes(record.status) && expected.expiresAt > BigInt(timestamp);
    return { ...context, expected, blockNumber, signer, response: { configured: true, exists: false,
      hidden: blocked(record), summary: null, wallet: null, evidence: null, actions } };
  }
  if (!validAddress(escrowAddress)) fail("failed-precondition", "The canonical independent escrow address is invalid.");
  const snapshot = await read(escrowAddress, funding.escrowAbi, "getState", [uid ?? record.researcherId]);
  if (!same(snapshot.listingId, entityId) || !same(snapshot.researcher, record.researcherId)
      || !same(snapshot.factory, funding.factoryAddress) || !same(snapshot.auditRegistry, config.address)
      || !same(snapshot.tokenRegistry, config.escrow.factoryAddress) || !same(snapshot.platformSigner, signer)) {
    fail("failed-precondition", "The escrow's immutable listing and funding terms do not match.");
  }
  const frozen = frozenTerms(snapshot, record, config, entityId);
  const refundOnly = !expected || !same(snapshot.termsHash, expected.termsHash)
    || !same(snapshot.listingContentHash, expected.prepared.contentHash);
  if (refundOnly) expected = frozen;
  const state = INDEPENDENT_FUNDING_STATES[Number(snapshot.state)];
  const amounts = Object.fromEntries(["totalDeposited", "totalReleased", "totalRefunded", "feePaid", "outstandingBalance", "refundPool", "yesWeight", "noWeight", "contribution", "refunded", "claimable"].map(name => [name, units(snapshot[name], name)]));
  if (!state || amounts.totalDeposited > expected.target || amounts.feePaid > amounts.totalReleased
      || amounts.totalReleased + amounts.totalRefunded + amounts.outstandingBalance !== amounts.totalDeposited
      || amounts.contribution > amounts.totalDeposited || amounts.refunded > amounts.contribution
      || amounts.claimable > amounts.outstandingBalance || amounts.yesWeight + amounts.noWeight > amounts.totalDeposited) {
    fail("failed-precondition", "The escrow balances or vote weights do not reconcile.");
  }
  if (!context.readable && amounts.contribution === 0n) fail("permission-denied", "This removed listing has no refund for your wallet.");
  const hidden = blocked(record) || !context.readable || refundOnly;
  const evidence = hidden ? null : await matchingEvidence({ db, record, evidenceHash: snapshot.evidenceHash });
  const summary = { proposalId, researcherId: record.researcherId, workflow: "independent-crowdfunding",
    title: hidden ? "Removed independent listing" : record.title, registryAddress: config.address.toLowerCase(),
    chainId: config.chainId, factoryAddress: funding.factoryAddress.toLowerCase(), escrowAddress: escrowAddress.toLowerCase(),
    proposalEntityId: expected.prepared.entityId, opportunityEntityId: expected.prepared.entityId,
    listingContentHash: snapshot.listingContentHash, termsHash: expected.termsHash,
    tokenAddress: expected.token.address.toLowerCase(), tokenSymbol: expected.token.symbol, tokenDecimals: expected.token.decimals,
    state, fundingTarget: expected.target.toString(), target: expected.target.toString(),
    ...Object.fromEntries(Object.entries(amounts).filter(([name]) => !["contribution", "refunded", "claimable"].includes(name)).map(([name, value]) => [name, value.toString()])),
    expiresAt: expected.expiresAt.toString(), reviewDays: expected.reviewDays,
    completionDeadline: units(snapshot.completionDeadline, "completion deadline").toString(),
    evidenceHash: snapshot.evidenceHash, evidenceVersion: safeInteger(snapshot.evidenceVersion, "evidence version"),
    funderCount: safeInteger(snapshot.funderCount, "funder count"), refundsEnabled: snapshot.refundsEnabled === true,
    active: snapshot.active === true, feeBps: safeInteger(snapshot.feeBps, "platform fee"), feeRecipient: snapshot.feeRecipient,
    upfrontReleased: amounts.totalReleased >= expected.target / 2n && amounts.totalReleased > 0n,
    finalReleased: amounts.totalReleased === expected.target, timestamp, blockNumber: safeInteger(blockNumber, "confirmed block"),
  };
  const wallet = { deposited: amounts.contribution.toString(), contribution: amounts.contribution.toString(),
    refunded: amounts.refunded.toString(), claimable: amounts.claimable.toString(),
    hasVoted: snapshot.hasVoted === true, votedApprove: snapshot.votedApprove === true,
    voteWeight: amounts.contribution.toString(), isResearcher: same(uid, record.researcherId), blockNumber: summary.blockNumber, stale: false };
  const actions = noActions(), author = same(uid, record.researcherId), visible = !hidden;
  actions.deposit = visible && !author && [0, 3].includes(context.profile?.role) && snapshot.depositsOpen === true;
  actions.accept = visible && author && snapshot.canAccept === true;
  actions.decline = visible && author && snapshot.canDecline === true;
  actions.submitEvidence = visible && author && snapshot.canSubmitEvidence === true;
  actions.vote = visible && Boolean(evidence) && snapshot.canVote === true && amounts.contribution > 0n;
  actions.releaseCompletion = visible && snapshot.canReleaseCompletion === true;
  // claimRefund applies expiry atomically; a separate expire transaction is not
  // necessary, and effective Expired snapshots cannot distinguish repeated calls.
  actions.expire = false;
  actions.claimRefund = amounts.claimable > 0n;
  return { ...context, expected, snapshot, blockNumber, signer, refundOnly,
    response: { configured: true, exists: true, hidden, refundOnly, summary, wallet, evidence, actions } };
}

export async function getIndependentFundingState(options) {
  return (await readState(options)).response;
}

export async function prepareIndependentFundingAction({ action, amount, evidence, evidenceHash, approve, reason, reasonHash, ...options }) {
  const verified = await readState(options), { response, record, expected } = verified;
  if (!Object.hasOwn(response.actions, action)) fail("invalid-argument", "Choose a valid independent funding action.");
  if (!response.actions[action]) fail("failed-precondition", "This funding action is not available for your wallet or the confirmed listing state.");
  const funding = options.config.independentFunding;
  let address = response.summary?.escrowAddress, abi = funding.escrowAbi, functionName, args, amountBaseUnits;
  if (action === "activate") {
    const error = fundingTargetError({ targetBaseUnits: expected.target, decimals: expected.token.decimals, symbol: expected.token.symbol });
    if (error) fail("invalid-argument", error);
    address = funding.factoryAddress; abi = funding.factoryAbi; functionName = "createEscrow";
    args = [expected.prepared.entityId, expected.token.address, expected.target, expected.reviewDays, expected.termsHash];
  } else if (action === "deposit") {
    amountBaseUnits = exactAmount(amount, expected.token.decimals);
    const error = fundingAmountError({ amountBaseUnits, decimals: expected.token.decimals, symbol: expected.token.symbol,
      remainingBaseUnits: expected.target - BigInt(response.summary.totalDeposited) });
    if (error) fail("invalid-argument", error);
    functionName = "deposit"; args = [amountBaseUnits];
  } else if (action === "submitEvidence") {
    const normalized = normalizeIndependentFundingEvidence(evidence), hash = hashIndependentFundingEvidence(normalized);
    if (!same(hash, evidenceHash) || same(hash, response.summary.evidenceHash)) fail("invalid-argument", "Submit new evidence matching its delivery hash.");
    const ref = options.db.collection("proposals").doc(record.id).collection("independentFundingEvidence").doc(hash);
    await options.db.runTransaction(async tx => {
      const existing = await tx.get(ref);
      if (existing.exists && (existing.data().ownerId !== options.uid || hashIndependentFundingEvidence(existing.data()) !== hash)) {
        fail("failed-precondition", "The saved delivery evidence differs from this hash.");
      }
      if (!existing.exists) tx.set(ref, { ...normalized, ownerId: options.uid, createdAt: Timestamp.now() });
    });
    functionName = "submitEvidence"; args = [hash];
  } else if (action === "vote") {
    if (typeof approve !== "boolean" || !same(evidenceHash, response.summary.evidenceHash)) fail("invalid-argument", "Review the current evidence and choose approve or reject.");
    functionName = "voteCompletion"; args = [BigInt(response.summary.evidenceVersion), evidenceHash, approve];
  } else if (action === "decline") {
    const message = String(reason ?? "").trim().normalize("NFC");
    if (message.length < 10 || message.length > 2000) fail("invalid-argument", "Provide a decline reason of 10–2,000 characters.");
    const digest = keccak256(stringToHex(JSON.stringify({ scheme: "qcdao.independent-funding.decline.v1", reason: message })));
    if (reasonHash !== undefined && !same(reasonHash, digest)) fail("invalid-argument", "The decline reason differs from its hash.");
    functionName = "declineFunding"; args = [digest];
  } else {
    functionName = { accept: "acceptFunding", expire: "expire", releaseCompletion: "releaseCompletion", claimRefund: "claimRefund" }[action];
    args = [];
  }
  // A new funder approves the ERC20 allowance after preparation. Simulating the
  // transfer here would reject every fresh wallet before that approval exists.
  if (action !== "deposit") await options.client.simulateContract({ address, abi, functionName, args, account: options.uid });
  return { action, chainId: options.config.chainId, address, abi, functionName, args: args.map(serialized),
    tokenAddress: expected.token.address, tokenSymbol: expected.token.symbol, tokenDecimals: expected.token.decimals,
    ...(amountBaseUnits !== undefined ? { amountBaseUnits: amountBaseUnits.toString() } : {}) };
}

async function verifiedReceipt({ client, config, verified, transactionHash, uid }) {
  if (!validHash(transactionHash)) fail("invalid-argument", "A valid funding transaction hash is required.");
  const [receipt, transaction] = await Promise.all([client.getTransactionReceipt({ hash: transactionHash }), client.getTransaction({ hash: transactionHash })]);
  const funding = config.independentFunding, factoryCall = same(transaction.to, funding.factoryAddress);
  if (receipt.status === "reverted") fail("failed-precondition", "The independent funding transaction reverted.");
  if (receipt.status !== "success" || !same(transaction.hash, transactionHash) || !same(receipt.transactionHash, transactionHash)
      || Number(transaction.chainId) !== config.chainId || (uid !== undefined && !same(transaction.from, uid))
      || (!factoryCall && !same(transaction.to, verified.response.summary?.escrowAddress))
      || typeof receipt.blockNumber !== "bigint" || receipt.blockNumber > verified.blockNumber
      || receipt.blockNumber !== transaction.blockNumber || !same(receipt.blockHash, transaction.blockHash)) {
    fail("failed-precondition", "The funding transaction is not a confirmed action for this wallet and listing.");
  }
  const [block, next] = await Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlock({ blockNumber: receipt.blockNumber + 1n })]);
  if (!same(block.hash, receipt.blockHash) || !same(next.parentHash, receipt.blockHash)) fail("unavailable", "The funding transaction needs canonical confirmations. Retry the same receipt shortly.");
  const abi = factoryCall ? funding.factoryAbi : funding.escrowAbi;
  const decoded = decodeFunctionData({ abi, data: transaction.input });
  if (factoryCall) {
    const expected = verified.expected;
    const args = [expected.prepared.entityId, expected.token.address, expected.target, expected.reviewDays, expected.termsHash];
    if (decoded.functionName !== "createEscrow" || !same(transaction.from, verified.record.researcherId)
        || decoded.args.length !== args.length || args.some((value, index) => !same(value, decoded.args[index]))) {
      fail("failed-precondition", "The escrow creation transaction differs from this listing's canonical terms.");
    }
  } else if (!["deposit", "acceptFunding", "declineFunding", "submitEvidence", "voteCompletion", "releaseCompletion", "adminCancel", "expire", "claimRefund"].includes(decoded.functionName)) {
    fail("failed-precondition", "This transaction is not an independent funding action.");
  }
  if ((receipt.logs?.length ?? 0) > 64) fail("resource-exhausted", "The funding receipt exceeds the bounded event budget.");
  const events = [];
  for (const log of receipt.logs ?? []) {
    const fromFactory = same(log.address, funding.factoryAddress);
    if (!fromFactory && !same(log.address, verified.response.summary?.escrowAddress)) continue;
    let event;
    try { event = decodeEventLog({ abi: fromFactory ? funding.factoryAbi : funding.escrowAbi, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
    if (fromFactory && (event.eventName !== "EscrowCreated" || !same(event.args.listingId, verified.expected.prepared.entityId)
      || !same(event.args.escrow, verified.response.summary?.escrowAddress) || !same(event.args.researcher, verified.record.researcherId))) continue;
    if (log.transactionHash && !same(log.transactionHash, transactionHash)) fail("failed-precondition", "The funding receipt contains inconsistent transaction events.");
    events.push({ id: `${config.chainId}_${funding.factoryAddress.toLowerCase()}_${transactionHash.toLowerCase()}_${safeInteger(log.logIndex, "event index")}`,
      eventType: event.eventName, actorId: transaction.from.toLowerCase(),
      args: Object.fromEntries(Object.entries(event.args).map(([key, value]) => [key, serialized(value)])),
      transactionHash, blockNumber: safeInteger(receipt.blockNumber, "transaction block"), timestamp: safeInteger(block.timestamp, "transaction time") });
  }
  if (!events.length) fail("failed-precondition", "No matching independent funding event was found in this receipt.");
  return events;
}

async function persistSnapshot({ db, config, verified, events = [], now = Timestamp.now() }) {
  const { record, response, expected, uid } = verified;
  if (!response.exists) return;
  const key = independentFundingKey(config, record.id), summaryRef = db.collection(INDEPENDENT_FUNDING_SUMMARIES).doc(key);
  const proposalRef = db.collection("proposals").doc(record.id);
  const positionRef = uid && BigInt(response.wallet.deposited) > 0n ? db.collection(INDEPENDENT_FUNDING_POSITIONS).doc(`${key}_${uid}`) : null;
  const jobRef = db.collection(INDEPENDENT_FUNDING_JOBS).doc(key);
  await db.runTransaction(async tx => {
    const [proposal, old, position, job] = await Promise.all([tx.get(proposalRef), tx.get(summaryRef), positionRef ? tx.get(positionRef) : null, tx.get(jobRef)]);
    if (!proposal.exists || recordFingerprint(proposal.data()) !== recordFingerprint(record)) {
      fail("aborted", "The listing changed during funding verification. Refresh before retrying.");
    }
    if ((old.data()?.blockNumber ?? 0) > response.summary.blockNumber) return;
    const summary = { ...response.summary, updatedAt: now, confirmedAt: now.toDate().toISOString() };
    tx.set(summaryRef, summary);
    signalFundingChange(tx, db, old.data(), summary);
    tx.update(proposalRef, { independentFunding: { activated: true, locked: true, ...summary }, updatedAt: now });
    if (positionRef && (position.data()?.blockNumber ?? 0) <= response.summary.blockNumber) tx.set(positionRef, {
      walletId: uid, proposalId: record.id, summaryKey: key, registryAddress: summary.registryAddress,
      factoryAddress: summary.factoryAddress, chainId: config.chainId, ...response.wallet, updatedAt: now,
    });
    const terminal = ["Released", "Declined", "Expired", "Cancelled", "Refunded"].includes(summary.state);
    const deadline = summary.state === "Accepted" ? summary.completionDeadline : summary.expiresAt;
    tx.set(jobRef, { ...(job.data() || {}), proposalId: record.id, status: terminal ? "complete" : "pending",
      nextAttemptAt: stamp(Math.max(now.toMillis() + 60_000, Number(deadline) * 1000)), updatedAt: now });
  });
  for (const event of events) {
    const ref = db.collection(INDEPENDENT_FUNDING_EVENTS).doc(event.id);
    const auditRef = db.collection("audits").doc(`independent_${event.id}`);
    await db.runTransaction(async tx => {
      const old = await tx.get(ref);
      if (old.exists) return;
      const item = { ...event, proposalId: record.id, researcherId: record.researcherId,
        registryAddress: config.address.toLowerCase(), factoryAddress: config.independentFunding.factoryAddress.toLowerCase(),
        escrowAddress: response.summary.escrowAddress, tokenSymbol: response.summary.tokenSymbol, tokenDecimals: response.summary.tokenDecimals };
      tx.set(ref, item);
      tx.set(auditRef, { ...item, type: "escrow", fundingWorkflow: "independent", action: `INDEPENDENT_${event.eventType.toUpperCase()}`,
        targetId: record.id, timestamp: stamp(event.timestamp * 1000), createdAt: now, chainStatus: "confirmed" });
    });
  }
}

export async function syncIndependentFunding({ transactionHash, now = Timestamp.now(), ...options }) {
  const verified = await readState(options);
  if (!verified.response.configured) fail("failed-precondition", "Independent funding is not configured for this deployment.");
  if (!verified.response.exists) fail("failed-precondition", "Activate the independent funding escrow first.");
  const events = transactionHash ? await verifiedReceipt({ ...options, verified, transactionHash }) : [];
  await persistSnapshot({ ...options, verified, events, now });
  return { ...verified.response, events };
}

export async function readIndependentFundingPortfolio({ db, config, uid }) {
  if (!/^0x[0-9a-f]{40}$/.test(uid ?? "")) fail("permission-denied", "Sign in with an active member wallet.");
  const profile = await db.collection("users").doc(uid).get();
  if (!profile.exists || profile.data().suspended) fail("permission-denied", "An active member profile is required.");
  if (!independentFundingConfigured(config)) return { items: [], truncated: false, snapshotOnly: true };
  const rows = await db.collection(INDEPENDENT_FUNDING_POSITIONS).where("walletId", "==", uid).limit(51).get();
  const items = await boundedMap(rows.docs.slice(0, 50), async row => {
    const position = row.data();
    if (position.chainId !== config.chainId || !same(position.registryAddress, config.address)
        || !same(position.factoryAddress, config.independentFunding.factoryAddress)) return null;
    const [summary, proposal] = await Promise.all([
      db.collection(INDEPENDENT_FUNDING_SUMMARIES).doc(independentFundingKey(config, position.proposalId)).get(),
      db.collection("proposals").doc(position.proposalId).get(),
    ]);
    if (!summary.exists || !proposal.exists) return null;
    const hidden = blocked(proposal.data());
    const stale = position.blockNumber < summary.data().blockNumber;
    return { ...summary.data(), title: hidden ? "Removed independent listing" : proposal.data().title,
      hidden, stale, detailRefreshRequired: stale, wallet: { deposited: position.deposited, refunded: position.refunded,
        claimable: stale ? null : position.claimable, lastKnownClaimable: position.claimable,
        blockNumber: position.blockNumber, stale } };
  });
  return { items: items.filter(Boolean), truncated: rows.size > 50, snapshotOnly: true };
}

export async function assertIndependentPublicationUnlocked({ db, client, config, proposalId, record }) {
  if (!isIndependentProposal(record) || !independentFundingConfigured(config)) return;
  const existing = await db.collection("proposals").doc(proposalId).get();
  if (!existing.exists || existing.data().status === "draft" || !isIndependentProposal(existing.data())) return;
  const oldPrepared = prepareStoredProposal({ ...existing.data(), id: proposalId }, { registryConfig: config });
  const nextPrepared = prepareStoredProposal({ ...record, id: proposalId }, { registryConfig: config });
  if (oldPrepared.canonicalPayload === nextPrepared.canonicalPayload
      && expectedTerms({ ...existing.data(), id: proposalId }, config).termsHash === expectedTerms({ ...record, id: proposalId }, config).termsHash
      && JSON.stringify(existing.data().attachments ?? []) === JSON.stringify(record.attachments ?? [])) return;
  const escrow = await client.readContract({ address: config.independentFunding.factoryAddress,
    abi: config.independentFunding.factoryAbi, functionName: "escrowForListing", args: [oldPrepared.entityId] });
  if (!same(escrow, ZERO_ADDRESS)) fail("failed-precondition", "An activated independent listing has immutable content and funding terms. Create a new listing for revisions.");
}

async function updateCancellation({ db, ref, job, now, changes }) {
  await db.runTransaction(async tx => {
    const [current, event] = await Promise.all([tx.get(ref), tx.get(db.collection("moderationEvents").doc(job.eventId))]);
    if (!current.exists || current.data().eventId !== job.eventId) return;
    tx.set(ref, { ...current.data(), ...changes, updatedAt: now });
    if (event.exists) tx.set(event.ref, { ...event.data(), independentFundingCancellation: {
      ...(event.data().independentFundingCancellation || {}), status: changes.status || "pending",
      ...(changes.transactionHash ? { transactionHash: changes.transactionHash } : {}),
      ...(changes.skipReason ? { skipReason: changes.skipReason } : {}),
    } });
  });
}

/** Process only a few due listings; platform nonce handling is shared with the
 * existing main/open-funding outbox, and signed bytes survive transport errors. */
export async function reconcileIndependentFunding({ db, client, config, getWallet, now = Timestamp.now(), outboxAlreadyResumed = false }) {
  if (!independentFundingConfigured(config)) return { processed: 0 };
  const [cancellations, jobs] = await Promise.all([
    db.collection(INDEPENDENT_FUNDING_CANCELLATIONS).where("status", "==", "pending")
      .where("nextAttemptAt", "<=", now).orderBy("nextAttemptAt").limit(3).get(),
    db.collection(INDEPENDENT_FUNDING_JOBS).where("status", "==", "pending")
      .where("nextAttemptAt", "<=", now).orderBy("nextAttemptAt").limit(3).get(),
  ]);
  if (!cancellations.size && !jobs.size) return { processed: 0 };
  if (!outboxAlreadyResumed) await resumePlatformTransaction({ db, client, config, now });
  let processed = 0;
  for (const row of cancellations.docs) {
    const job = row.data();
    try {
      const verified = await readState({ db, client, config, proposalId: job.proposalId });
      if (!verified.response.exists) {
        await updateCancellation({ db, ref: row.ref, job, now, changes: { status: "skipped", skipReason: "no-escrow" } });
        processed++; continue;
      }
      const { summary } = verified.response;
      if (job.transactionHash) {
        let events;
        try { events = await verifiedReceipt({ client, config, verified, transactionHash: job.transactionHash }); }
        catch (error) {
          if (error instanceof HttpsError && error.message === "The independent funding transaction reverted.") {
            await updateCancellation({ db, ref: row.ref, job, now, changes: { status: "pending", transactionHash: null,
              nextAttemptAt: stamp(now.toMillis() + 60_000) } });
            processed++; continue;
          }
          throw error;
        }
        await persistSnapshot({ db, config, verified, events, now });
      }
      if (["Declined", "Expired", "Cancelled", "Refunded", "Released"].includes(summary.state)) {
        await persistSnapshot({ db, config, verified, now });
        await updateCancellation({ db, ref: row.ref, job, now, changes: { status: "complete",
          ...(job.transactionHash ? { transactionHash: job.transactionHash } : {}),
          ...(summary.state === "Released" ? { skipReason: "already-released" } : {}) } });
        processed++; continue;
      }
      if (!blocked(verified.record) && !job.transactionHash) {
        await updateCancellation({ db, ref: row.ref, job, now, changes: { status: "skipped", skipReason: "restored-before-cancellation" } });
        processed++; continue;
      }
      const wallet = await getWallet();
      if (!same(wallet.account.address, verified.signer)) fail("failed-precondition", "The independent funding platform signer does not match.");
      const result = await submitPlatformAction({ db, client, config, getWallet: () => wallet, now,
        action: { address: summary.escrowAddress, abi: config.independentFunding.escrowAbi,
          functionName: "adminCancel", args: [job.reasonHash],
          key: `independent-cancel:${job.proposalId}:${job.eventId}` } });
      await updateCancellation({ db, ref: row.ref, job, now, changes: { status: "pending",
        ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
        nextAttemptAt: stamp(now.toMillis() + 60_000) } });
      processed++;
    } catch {
      await row.ref.update({ nextAttemptAt: stamp(now.toMillis() + 60_000), updatedAt: now,
        lastError: "Independent funding cancellation is awaiting canonical confirmation or deployment configuration." });
    }
  }
  for (const row of jobs.docs) {
    try {
      const verified = await readState({ db, client, config, proposalId: row.data().proposalId });
      // getState derives Expired and proportional claims from the confirmed
      // block time, so refunds need no keeper transaction or historical scan.
      await persistSnapshot({ db, config, verified, now });
      processed++;
    } catch {
      await row.ref.update({ nextAttemptAt: stamp(now.toMillis() + 60_000), updatedAt: now,
        lastError: "Independent funding state is temporarily unavailable." });
    }
  }
  return { processed };
}

export const sweepIndependentFunding = reconcileIndependentFunding;
