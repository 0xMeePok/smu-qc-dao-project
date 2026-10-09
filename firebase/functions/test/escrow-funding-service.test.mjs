import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256 } from "viem";
import { escrowClient, escrowConfig, escrowRecord, escrowAddress, owner, researcher, txHash } from "./fixtures/escrowAuditFixture.js";
import { memoryDb } from "./memoryDb.mjs";
import { prepareStoredProposal } from "../proposalAuditPayload.js";
import { fundingDigest } from "../escrowFundingEvents.js";
import { deploymentKey, enqueueEscrowFunding, fundingBlockReason, getEscrowFundingHistory, getEscrowFundingSummary,
  prepareEscrowDeposit, readVerifiedFunding, reconcilePostingFundingPause, resumePlatformTransaction, settlementAction,
  startEscrowSettlement, submitPlatformAction, syncEscrowFunding, queuePostingFundingPause } from "../escrowFunding.js";
import { sweepEscrowFunding } from "../escrowFunding.js";
import { getFunderDashboard } from "../funderDashboard.js";

const hash = digit => `0x${digit.repeat(64)}`, zero = hash("0"), platform = `0x${"9".repeat(40)}`;
const now = Timestamp.fromMillis(1900000000000), nextDay = 1900086400n;
const config = { ...escrowConfig, deployment: { blockNumber: 80 } };
const key = id => `${deploymentKey(config)}_${id}`;

function fixture({ release = false } = {}) {
  const record = escrowRecord(); record.audit.status = "confirmed"; record.audit.blockNumber = 88;
  const expected = prepareStoredProposal(record, { registryConfig: config });
  const parent = { id: record.problemId, ownerId: owner, status: "submitted", title: "Posting", expiresAt: Timestamp.fromMillis(2000000000000) };
  const db = memoryDb({ [`users/${owner}`]: { role: 0 }, [`users/${researcher}`]: { role: 0 },
    [`users/${platform}`]: { role: 1 }, [`proposals/${record.id}`]: record, [`problems/${record.problemId}`]: parent });
  const client = escrowClient(record), originalRead = client.readContract;
  const receipts = new Map(), anchors = [], reads = [], ranges = [];
  const state = { state: release ? 6 : 0, totalDeposited: BigInt(record.fundingTerms.target),
    totalReleased: release ? BigInt(record.fundingTerms.target) / 2n : 0n, totalRefunded: 0n,
    currentTranche: release ? 1n : 0n, selectionId: hash("5"), ownerApproved: false, solutionApproved: false,
    yesWeight: 0n, approvalDeadline: nextDay, expiresAt: 2000000000n, platformSigner: platform,
    active: true, invalidated: false, pendingProposalEntityId: zero };
  function eventLog(eventName, args, logIndex, transactionHash, blockNumber) {
    const registry = ["FundingEventAnchored", "ProposalEscrowLinked"].includes(eventName);
    const abi = registry ? config.abi : config.escrow.escrowAbi;
    const spec = abi.find(item => item.type === "event" && item.name === eventName), data = spec.inputs.filter(item => !item.indexed);
    return { address: registry ? config.address : escrowAddress, logIndex, blockNumber, blockHash: hash("4"), transactionHash,
      args, topics: encodeEventTopics({ abi, eventName, args }), data: encodeAbiParameters(data, data.map(item => args[item.name])) };
  }
  function add(type, digest, name, args, transactionHash, blockNumber, actor) {
    const anchor = eventLog("FundingEventAnchored", { proposalId: expected.entityId, escrow: escrowAddress,
      eventType: type, digest, actor, timestamp: 1900000000n }, 0, transactionHash, blockNumber);
    const log = eventLog(name, args, 1, transactionHash, blockNumber);
    anchors.push(anchor);
    receipts.set(transactionHash, { to: config.address, transactionHash, status: "success", blockNumber, blockHash: hash("4"), logs: [anchor, log] });
  }
  add(0, expected.fundingTermsHash, "ProposalEscrowLinked", { proposalId: expected.entityId, postingId: expected.opportunityId,
    escrow: escrowAddress, termsHash: expected.fundingTermsHash }, txHash, 88n, researcher);
  const amount = BigInt(record.fundingTerms.target);
  add(1, fundingDigest(["address", "uint256", "uint256"], [owner, amount, amount]), "Deposited", {
    postingId: expected.opportunityId, proposalId: expected.entityId, depositor: owner, token: record.fundingTerms.token,
    amount, cumulativeAmount: amount, depositNumber: 1n }, hash("6"), 90n, owner);
  if (release) add(8, fundingDigest(["uint256", "bytes32", "uint256", "uint256"], [0n, zero, amount / 2n, 0n]),
    "TrancheReleased", { index: 0n, evidenceHash: zero, grossAmount: amount / 2n, fee: 0n, netAmount: amount / 2n }, hash("7"), 95n, platform);
  client.getChainId = async () => 421614;
  client.getBlockNumber = async () => 101n;
  client.getBlock = async () => ({ hash: hash("4"), timestamp: 1900000000n });
  client.getTransactionReceipt = async ({ hash: value }) => { if (!receipts.has(value)) throw new Error("Receipt not found"); return receipts.get(value); };
  client.getLogs = async request => { ranges.push(request); return anchors.filter(log => log.blockNumber >= request.fromBlock && log.blockNumber <= request.toBlock); };
  client.readContract = async request => {
    reads.push(request);
    if (request.functionName === "depositorSummary") return request.args[0].toLowerCase() === owner.toLowerCase()
      ? { deposited: state.totalDeposited, refunded: state.totalRefunded, released: state.totalReleased, claimable: 0n }
      : { deposited: 0n, refunded: 0n, released: 0n, claimable: 0n };
    if (request.functionName === "fundingAnchorCount") return BigInt(anchors.length);
    if (request.functionName === "isFundingActive") return state.active;
    if (request.functionName === "isFundingInvalidated") return state.invalidated;
    if (request.functionName === "pendingProposalForPosting") return state.pendingProposalEntityId;
    if (request.functionName === "platformSigner") return platform;
    if (request.functionName === "outstandingBalance") return state.totalDeposited - state.totalReleased - state.totalRefunded;
    if (request.functionName in state && request.address === escrowAddress) return state[request.functionName];
    const result = await originalRead(request);
    if (request.functionName === "milestoneAt") return { ...result, evidenceHash: Number(request.args[0]) === 0 ? zero : hash("8"),
      fee: 0n, paid: release && Number(request.args[0]) === 0 };
    return result;
  };
  return { db, client, config, record, parent, expected, state, receipts, anchors, reads, ranges, add, eventLog, now };
}

const currentMainConfig = { ...config, abi: [...config.abi.filter(item => item.name !== "pendingProposalForPosting"),
  { type: "function", name: "pendingProposalForPosting", stateMutability: "view", inputs: [{ name: "postingId", type: "bytes32" }], outputs: [{ name: "", type: "bytes32" }] }] };
const localWorkerWallet = signedBytes => () => ({ account: { address: platform }, chain: { id: 421614 },
  prepareTransactionRequest: async request => request, signTransaction: async () => signedBytes });

describe("escrow funding service", () => {
  it("projects confirmed chain deposits, hashes and exact base units with deterministic audit IDs", async () => {
    const f = fixture();
    const result = await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner });
    assert.equal(result.reconciliation.status, "verified");
    assert.equal(result.reconciliation.anchors, 2);
    assert.equal(result.summary.totalDeposited, f.record.fundingTerms.target);
    assert.equal(result.summary.registryAddress, config.address);
    assert.equal(result.events[0].amountBaseUnits, f.record.fundingTerms.target);
    assert.equal([...f.db.records.keys()].filter(path => path.startsWith("audits/")).length, 2);
    assert(f.reads.filter(item => ["getProposal", "fundingTarget"].includes(item.functionName)).every(item => item.blockNumber === 100n));
    await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner });
    assert.equal([...f.db.records.keys()].filter(path => path.startsWith("audits/")).length, 2);
  });

  it("starts a new scan at the verified creation receipt instead of the deployment block", async () => {
    const f = fixture();
    f.record.audit.blockNumber = 99;
    const result = await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner });
    assert.equal(f.ranges[0].fromBlock, 88n);
    assert.equal(result.reconciliation.anchors, 2);
    assert.equal(result.reconciliation.status, "verified");
  });

  it("refreshes every depositor's saved allocation after a payout submitted by another wallet", async () => {
    const f = fixture({ release: true }), other = `0x${"a".repeat(40)}`;
    f.db.records.set("escrowFundingEvents/historical-other-deposit", {
      proposalId: f.record.id, registryAddress: f.config.address.toLowerCase(), chainId: f.config.chainId,
      eventType: "Deposit", verified: true, actor: other,
    });
    const read = f.client.readContract;
    f.client.readContract = async request => request.functionName === "depositorSummary"
      ? { deposited: 100n, released: 50n, refunded: 0n, claimable: 0n } : read(request);
    await syncEscrowFunding({ ...f, uid: researcher, proposalId: f.record.id });
    for (const wallet of [owner, other]) {
      const row = f.db.records.get(`escrowFundingPositions/${key(f.record.id)}_${wallet.toLowerCase()}`);
      assert.equal(row.released, "50"); assert.equal(row.locked, "50"); assert.equal(row.blockNumber, 100);
    }
  });

  it("does not repeat depositor RPC reads on unchanged background reconciliations", async () => {
    const f = fixture();
    await syncEscrowFunding({ ...f, uid: owner, proposalId: f.record.id });
    const first = f.reads.filter(row => row.functionName === "depositorSummary").length;
    assert.equal(first, 1);
    f.client.getBlockNumber = async () => 102n;
    await syncEscrowFunding({ ...f, uid: owner, proposalId: f.record.id });
    assert.equal(f.reads.filter(row => row.functionName === "depositorSummary").length, first);
    assert.equal(f.db.records.get(`escrowFundingSummaries/${key(f.record.id)}`).blockNumber, 101);
    f.state.totalRefunded = f.state.totalDeposited;
    f.client.getBlockNumber = async () => 103n;
    await syncEscrowFunding({ ...f, uid: owner, proposalId: f.record.id });
    assert.equal(f.reads.filter(row => row.functionName === "depositorSummary").length, first + 1);
    assert.equal(f.db.records.get(`escrowFundingPositions/${key(f.record.id)}_${owner}`).refunded, f.state.totalDeposited.toString());
  });

  it("uses positions written by real reconciliation without RPC, including after a newer unchanged block", async () => {
    const f = fixture();
    await syncEscrowFunding({ ...f, uid: owner, proposalId: f.record.id });
    const rejectRpc = new Proxy({}, { get() { throw new Error("Saved reconciled positions must not access RPC"); } });
    let dashboard = await getFunderDashboard({ ...f, uid: owner, client: rejectRpc });
    assert.equal(dashboard.commitments.length, 1);
    assert.equal(dashboard.unavailableCommitments, 0);
    assert.equal(dashboard.commitments[0].committed, f.state.totalDeposited.toString());
    f.client.getBlockNumber = async () => 102n;
    await syncEscrowFunding({ ...f, uid: owner, proposalId: f.record.id });
    dashboard = await getFunderDashboard({ ...f, uid: owner, client: rejectRpc });
    assert.equal(dashboard.commitments.length, 1);
    assert.equal(dashboard.unavailableCommitments, 0);
  });

  it("indexes original creation even when audit.transactionHash points at a later proposal amendment", async () => {
    const f = fixture(), amendment = hash("a");
    f.receipts.set(amendment, { to: config.address, status: "success", blockNumber: 99n,
      blockHash: hash("4"), logs: [], transactionHash: amendment });
    f.client.getTransaction = async () => ({ hash: amendment, to: config.address, from: researcher, chainId: config.chainId,
      blockNumber: 99n, blockHash: hash("4"), input: encodeFunctionData({ abi: config.abi, functionName: "updateHashes",
        args: [f.expected.entityId, f.expected.proposalHash, f.expected.solutionHash, 0] }) });
    f.record.audit.transactionHash = amendment;
    f.record.audit.blockNumber = 99;
    const result = await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner });
    assert.equal(f.ranges[0].fromBlock, 80n);
    assert.equal(result.reconciliation.anchors, 2);
  });

  it("keeps the deployment checkpoint when creation identity or receipt consistency cannot be verified", async () => {
    const variants = [
      transaction => ({ ...transaction, from: owner }),
      transaction => ({ ...transaction, input: encodeFunctionData({ abi: config.abi,
        functionName: "commitProposalWithEscrow", args: [zero, ...prepareStoredProposal(escrowRecord(), { registryConfig: config }).args.slice(1)] }) }),
      transaction => ({ ...transaction, blockNumber: 99n }),
      transaction => ({ ...transaction, input: "0x12345678" }),
    ];
    for (const variant of variants) {
      const f = fixture(), original = f.client.getTransaction;
      f.client.getTransaction = async request => variant(await original(request));
      const result = await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner });
      assert.equal(f.ranges[0].fromBlock, 80n);
      assert.equal(result.reconciliation.anchors, 2);
    }
  });

  it("persists a bounded scan cursor and publishes no summary until the complete registry history is reconciled", async () => {
    const f = fixture(); f.client.getBlockNumber = async () => 30100n;
    let result = await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner });
    assert.equal(result.reconciliation.complete, false); assert.equal(result.summary, null);
    assert.equal(f.ranges[0].toBlock - f.ranges[0].fromBlock + 1n, 10000n);
    f.client.getTransaction = async () => { throw new Error("A resumed scan must use its saved cursor"); };
    for (let index = 0; index < 3; index++) result = await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner });
    assert.equal(result.reconciliation.complete, true); assert.equal(result.reconciliation.anchors, 2);
    assert.equal(f.ranges[1].fromBlock, f.ranges[0].toBlock + 1n);
    assert(f.reads.filter(item => item.functionName === "getProposal").every(item => item.blockNumber === 30099n));
  });

  it("preserves two owner release notifications across retries and exposes confirmed dashboard settlement", async () => {
    const f = fixture({ release: true });
    await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner });
    const notices = [...f.db.records].filter(([path]) => path.startsWith("moderationNotifications/"));
    assert.equal(notices.length, 2);
    assert.deepEqual(notices.map(([, value]) => value.recipientId).sort(), [owner, researcher].sort());
    const [path, notice] = notices[0]; f.db.records.set(path, { ...notice, readAt: now });
    await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: researcher });
    assert.equal(f.db.records.get(path).readAt, now);
    const dashboard = await getEscrowFundingSummary({ ...f, uid: owner });
    assert.equal(dashboard.items.length, 1); assert.equal(dashboard.items[0].upfrontReleased, true);
    assert.equal(f.db.records.get(`problems/${f.record.problemId}`).acceptedProposalId, f.record.id);
    assert.equal(f.db.records.get(`proposals/${f.record.id}`).status, "accepted");
  });

  it("uses saved payment balances without RPC, while confirmed sync updates the saved result", async () => {
    const f = fixture({ release: true });
    await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner });
    const cachePath = `escrowFundingSummaries/${key(f.record.id)}`;
    const cached = f.db.records.get(cachePath);
    f.state.totalReleased = f.state.totalDeposited;
    f.state.state = 2; f.state.currentTranche = 2n;
    const read = f.client.readContract;
    f.client.readContract = async request => request.functionName === "milestoneAt"
      ? { ...await read(request), paid: true } : read(request);
    f.client.getBlockNumber = async options => { assert.equal(options.cacheTime, 0); return 103n; };
    const result = await getEscrowFundingSummary({ ...f, uid: owner });
    assert.equal(result.items[0].totalReleased, cached.totalReleased);
    assert.equal(result.items[0].outstandingBalance, cached.outstandingBalance);
    assert.equal(result.items[0].finalReleased, false); assert.equal(result.blockNumber, 100);
    assert.equal(result.unavailableItems, 0); assert.equal(f.db.records.get(cachePath), cached);
    await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner });
    const refreshed = await getEscrowFundingSummary({ ...f, uid: owner });
    assert.equal(refreshed.items[0].totalReleased, f.state.totalDeposited.toString());
    assert.equal(refreshed.items[0].outstandingBalance, "0");
    assert.equal(refreshed.items[0].finalReleased, true);
  });

  it("retains saved payment balances when RPC is unavailable", async () => {
    const f = fixture({ release: true });
    await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner });
    f.client.readContract = async () => { throw new Error("RPC unavailable"); };
    const result = await getEscrowFundingSummary({ ...f, uid: owner });
    assert.equal(result.items.length, 1); assert.equal(result.unavailableItems, 0);
  });
  it("verifies a missing payment snapshot once and reuses it without blockchain calls", async () => {
    const f = fixture({ release: true });
    const first = await getEscrowFundingSummary({ ...f, uid: owner });
    assert.equal(first.items.length, 1); assert.equal(first.items[0].snapshotVerified, true);
    assert(f.reads.length > 0);
    f.client = new Proxy({}, { get() { throw new Error("Repeated dashboard must not access RPC"); } });
    const second = await getEscrowFundingSummary({ ...f, uid: owner });
    assert.deepEqual(second, first);
  });
  it("reports unavailable for missing snapshots if verification fails instead of fabricating zero payments", async () => {
    const f = fixture(); f.client.readContract = async () => { throw new Error("RPC unavailable"); };
    const result = await getEscrowFundingSummary({ ...f, uid: owner });
    assert.equal(result.items.length, 0); assert.equal(result.unavailableItems, 1);
    assert.equal(f.db.records.has(`escrowFundingSummaries/${key(f.record.id)}`), false);
  });
  it("deduplicates payment discovery and excludes projections from another chain", async () => {
    const f = fixture({ release: true });
    await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner });
    const cached = f.db.records.get(`escrowFundingSummaries/${key(f.record.id)}`);
    f.db.records.set("escrowFundingSummaries/duplicate", { ...cached });
    f.db.records.set("escrowFundingSummaries/foreign", { ...cached, chainId: 1, proposalId: "foreign" });
    const result = await getEscrowFundingSummary({ ...f, uid: owner });
    assert.equal(result.items.length, 1); assert.equal(result.unavailableItems, 0);
  });

  it("rejects mismatched proposal content and never saves a confirmed projection on failed reconciliation", async () => {
    const f = fixture(), read = f.client.readContract;
    f.client.readContract = async request => request.functionName === "getProposal"
      ? { ...await read(request), proposalHash: zero } : read(request);
    await assert.rejects(syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner }), /mismatch/);
    assert(!f.db.records.has(`escrowFundingSummaries/${key(f.record.id)}`));
  });

  it("does not index a historical deployment as the active one", async () => {
    const f = fixture(); f.receipts.get(txHash).to = `0x${"1".repeat(40)}`;
    await assert.rejects(syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner }), /different.*registry/);
    assert.equal(f.db.records.get(`escrowFundingJobs/${key(f.record.id)}`).status, "historical");
  });

  it("does not enable automatic settlement until the active manifest includes posting selection and pause guards", async () => {
    const f = fixture();
    const oldConfig = { ...config, abi: config.abi.filter(item => item.name !== "postingFundingPaused") };
    await assert.rejects(syncEscrowFunding({ ...f, config: oldConfig, proposalId: f.record.id, uid: owner }), /Redeploy the current escrow/);
    assert.equal(f.reads.length, 0);
  });

  it("checks signed-member visibility and prevents a third party selecting the proposal", async () => {
    const f = fixture();
    await assert.rejects(getEscrowFundingHistory({ db: f.db, config, uid: `0x${"2".repeat(40)}`, proposalId: f.record.id }), /not available/);
    await assert.rejects(startEscrowSettlement({ ...f, uid: researcher, proposalId: f.record.id }), /Only the posting owner/);
  });

  it("allows a posting owner to fund but blocks hidden parents, mismatched chain, closed windows and different winners", async () => {
    const f = fixture(); f.state.totalDeposited = 10n;
    assert.equal((await prepareEscrowDeposit({ ...f, uid: owner, proposalId: f.record.id })).escrowAddress, escrowAddress);
    f.db.records.set(`problems/${f.parent.id}`, { ...f.parent, moderationStatus: "hidden" });
    await assert.rejects(prepareEscrowDeposit({ ...f, uid: owner, proposalId: f.record.id }), /moderated/);
    f.client.getChainId = async () => 1;
    await assert.rejects(prepareEscrowDeposit({ ...f, uid: owner, proposalId: f.record.id }), /Arbitrum Sepolia/);
    assert.match(fundingBlockReason(f.record, { ...f.parent, acceptedProposalId: "another" }), /different proposal/);
    assert.match(fundingBlockReason(f.record, { ...f.parent, status: "expired" }, null, now.toMillis(), { deposit: true }), /window is closed/);
  });

  it("requires owner selection and both current approvals; final voting is conditional", async () => {
    const f = fixture(), verified = await readVerifiedFunding({ ...f, blockNumber: 100n });
    const decision = (job = {}) => settlementAction({ ...f, verified, job });
    assert.equal(decision().settlement.status, "waiting");
    assert.equal(decision({ selectionRequested: true, selectionId: hash("5") }).action.functionName, "lockSelection");
    verified.summary.state = "Locked";
    assert.equal(decision().settlement.status, "awaiting-approvals");
    verified.data.ownerApproved = true;
    assert.equal(decision().settlement.status, "awaiting-approvals");
    verified.data.solutionApproved = true;
    assert.equal(decision().action.functionName, "release");
    verified.summary.state = "Active"; verified.data.currentTranche = 1n;
    assert.equal(decision().settlement.status, "awaiting-votes");
    verified.data.yesWeight = verified.data.totalDeposited / 2n + 1n;
    const final = decision().action;
    assert.equal(final.functionName, "releaseMilestone");
    assert.deepEqual(final.args, [hash("5"), 1n, hash("8")]);
    assert(!final.args.includes(owner)); // No caller-controlled recipient override.
  });

  it("reuses identical pinned escrow fields within verification but reads fresh state on the next request", async () => {
    const f = fixture();
    const first = await readVerifiedFunding({ ...f, blockNumber: 100n });
    assert.equal(first.summary.totalReleased, "0");
    assert.equal(f.reads.filter(read => read.functionName === "expiresAt").length, 1);
    assert.deepEqual(f.reads.filter(read => read.functionName === "milestoneAt").map(read => read.args[0]), [0n, 1n]);
    assert(f.reads.every(read => read.blockNumber === 100n));
    f.reads.length = 0;
    f.state.totalReleased = 100n;
    const second = await readVerifiedFunding({ ...f, blockNumber: 101n });
    assert.equal(second.summary.totalReleased, "100");
    assert(f.reads.length > 0 && f.reads.every(read => read.blockNumber === 101n));
  });

  it("requires full funding before reserving a main proposal and blocks siblings using the confirmed chain pending selection", async () => {
    const f = fixture(); f.config = currentMainConfig; f.state.totalDeposited = 10n;
    await assert.rejects(startEscrowSettlement({ ...f, uid: owner, proposalId: f.record.id }), /fully funded/);
    assert.equal(f.db.records.get(`problems/${f.parent.id}`).escrowSelection, undefined);
    f.state.pendingProposalEntityId = hash("a"); f.state.active = false;
    const verified = await readVerifiedFunding({ ...f, blockNumber: 100n });
    assert.equal(verified.summary.pendingProposalEntityId, hash("a"));
    assert.equal(verified.summary.invalidated, false);
    assert(f.reads.filter(read => ["pendingProposalForPosting", "isFundingInvalidated"].includes(read.functionName)).every(read => read.blockNumber === 100n));
    await assert.rejects(prepareEscrowDeposit({ ...f, uid: owner, proposalId: f.record.id }), /awaiting owner acceptance/);
    assert.equal(settlementAction({ ...f, verified, job: {} }).action, undefined);
  });

  it("uses confirmed chain time for handshake expiry and preserves historical main expiry semantics without the new getter", async () => {
    const f = fixture(); f.config = currentMainConfig; f.state.state = 1;
    f.state.ownerApproved = true; f.state.solutionApproved = true;
    const verified = await readVerifiedFunding({ ...f, blockNumber: 100n });
    const decision = () => settlementAction({ ...f, verified, job: {}, now: Timestamp.fromMillis(2100000000000) });
    assert.equal(decision().action.functionName, "release"); // A future host clock cannot expire a live chain window.
    verified.summary.timestamp = Number(f.state.approvalDeadline);
    assert.equal(decision().action.functionName, "expire");
    const legacyConfig = { ...config, abi: config.abi.filter(item => item.name !== "pendingProposalForPosting") };
    assert.equal(settlementAction({ ...f, config: legacyConfig, verified, job: {} }).settlement.status, "blocked");
    verified.summary.timestamp = Number(f.state.expiresAt);
    assert.equal(settlementAction({ ...f, config: legacyConfig, verified, job: {} }).action.functionName, "expire");
    verified.summary.state = "Active"; verified.summary.timestamp = Number(f.state.approvalDeadline);
    assert.equal(settlementAction({ ...f, config: legacyConfig, verified, job: {} }).action.functionName, "expire");
  });

  it("requires both final approvals and strictly more than half the deposit weight only when funder voting is configured", async () => {
    const f = fixture({ release: true }), verified = await readVerifiedFunding({ ...f, blockNumber: 100n });
    const decision = () => settlementAction({ ...f, verified, job: {} });
    assert.equal(decision().settlement.status, "awaiting-approvals");
    verified.data.ownerApproved = true;
    assert.equal(decision().settlement.status, "awaiting-approvals");
    verified.data.solutionApproved = true; verified.data.yesWeight = verified.data.totalDeposited / 2n;
    assert.equal(decision().settlement.status, "awaiting-votes");
    verified.data.yesWeight++;
    assert.equal(decision().action.functionName, "releaseMilestone");
    verified.expected = { ...verified.expected, fundingTerms: { ...verified.expected.fundingTerms, funderVoting: false } };
    verified.data.yesWeight = 0n;
    assert.equal(decision().action.functionName, "releaseMilestone");
    verified.milestones[1].evidenceHash = zero;
    assert.equal(decision().settlement.status, "waiting");
  });

  it("automatically expires an unanswered main selection and clears its posting reservation only after confirmed reconciliation", async () => {
    const f = fixture(); f.config = currentMainConfig; f.state.state = 1;
    f.state.pendingProposalEntityId = f.expected.entityId;
    const selectionId = f.state.selectionId, boundary = f.state.approvalDeadline, signedBytes = "0x3456", pendingHash = keccak256(signedBytes), actions = [];
    f.add(2, fundingDigest(["bytes32", "address", "uint64"], [selectionId, researcher, boundary]), "SelectionLocked",
      { selectionId, solutionOwner: researcher, approvalDeadline: boundary }, hash("d"), 95n, platform);
    f.client.getBlock = async ({ blockNumber } = {}) => ({ hash: hash("4"), timestamp: blockNumber >= 100n ? boundary : 1900000000n });
    f.client.simulateContract = async request => actions.push(request.functionName);
    f.client.getTransactionCount = async () => 7;
    f.client.sendRawTransaction = async () => pendingHash;
    await enqueueEscrowFunding(f);
    const parentPath = `problems/${f.parent.id}`, jobPath = `escrowFundingJobs/${key(f.record.id)}`;
    f.db.records.set(parentPath, { ...f.parent, escrowSelection: { proposalId: f.record.id, selectionId, registryAddress: config.address } });
    f.db.records.set(jobPath, { ...f.db.records.get(jobPath), selectionId, selectionRequested: true });
    const getWallet = localWorkerWallet(signedBytes), runAt = Timestamp.fromMillis(Number(boundary) * 1000);
    assert.equal((await sweepEscrowFunding({ ...f, getWallet, now: runAt })).processed, 1);
    assert.deepEqual(actions, ["expire"]);
    assert(f.db.records.get(parentPath).escrowSelection);
    const anchor = f.eventLog("FundingEventAnchored", { proposalId: f.expected.entityId, escrow: escrowAddress, eventType: 6,
      digest: fundingDigest(["uint256", "uint256", "uint256"], [0n, boundary, f.state.totalDeposited]), actor: platform, timestamp: boundary }, 2, pendingHash, 102n);
    f.anchors.push(anchor);
    f.receipts.set(pendingHash, { to: escrowAddress, transactionHash: pendingHash, status: "success", blockNumber: 102n, blockHash: hash("4"), logs: [
      f.eventLog("StateChanged", { previousState: 1, newState: 5 }, 0, pendingHash, 102n),
      f.eventLog("RefundsOpened", { pool: f.state.totalDeposited, availableAt: boundary }, 1, pendingHash, 102n), anchor] });
    f.state.state = 5; f.state.pendingProposalEntityId = zero; f.client.getBlockNumber = async () => 103n;
    await sweepEscrowFunding({ ...f, getWallet, now: Timestamp.fromMillis(runAt.toMillis() + 60000) });
    assert.equal(f.db.records.get(parentPath).escrowSelection, null);
    assert.equal(f.db.records.get(jobPath).selectionRequested, false);
    assert.equal(f.db.records.get(`escrowFundingSummaries/${key(f.record.id)}`).state, "Expired");
    assert.deepEqual(actions, ["expire"]);
  });

  it("automatically opens refunds for an invalidated losing sibling but never refunds one that is only temporarily paused", async () => {
    const f = fixture(); f.config = currentMainConfig; f.state.active = false;
    f.state.pendingProposalEntityId = hash("a");
    let verified = await readVerifiedFunding({ ...f, blockNumber: 100n });
    assert.equal(settlementAction({ ...f, verified, job: {} }).action, undefined);
    f.state.pendingProposalEntityId = zero; f.state.invalidated = true;
    f.db.records.set(`problems/${f.parent.id}`, { ...f.parent, acceptedProposalId: "winner-proposal" });
    const signedBytes = "0x4567", pendingHash = keccak256(signedBytes), actions = [];
    f.client.simulateContract = async request => actions.push(request.functionName);
    f.client.getTransactionCount = async () => 7; f.client.sendRawTransaction = async () => pendingHash;
    await enqueueEscrowFunding(f);
    assert.equal((await sweepEscrowFunding({ ...f, getWallet: localWorkerWallet(signedBytes) })).processed, 1);
    assert.deepEqual(actions, ["refundInvalidated"]);
    f.state.state = 7;
    verified = await readVerifiedFunding({ ...f, blockNumber: 100n });
    assert.equal(settlementAction({ ...f, verified, parent: { ...f.parent, acceptedProposalId: "winner-proposal" }, job: {} }).action, undefined);
  });

  it("consumes invalidated selection requests and releases the pre-payment posting reservation", async () => {
    const f = fixture(), selectionId = hash("5"), reason = hash("b");
    f.add(4, fundingDigest(["bytes32", "bytes32"], [selectionId, reason]), "SelectionInvalidated",
      { selectionId, reasonHash: reason }, hash("c"), 95n, platform);
    f.state.selectionId = zero;
    await enqueueEscrowFunding({ ...f });
    const jobPath = `escrowFundingJobs/${key(f.record.id)}`;
    f.db.records.set(jobPath, { ...f.db.records.get(jobPath), selectionRequested: true, selectionId });
    f.db.records.set(`problems/${f.parent.id}`, { ...f.parent, escrowSelection: { proposalId: f.record.id, selectionId, registryAddress: config.address } });
    const result = await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner, getWallet: () => { throw new Error("Should not auto-reselect"); } });
    assert.equal(result.settlement.status, "waiting");
    assert.equal(f.db.records.get(jobPath).selectionRequested, false);
    assert.equal(f.db.records.get(`problems/${f.parent.id}`).escrowSelection, null);
    await startEscrowSettlement({ ...f, proposalId: f.record.id, uid: owner });
    assert.notEqual(f.db.records.get(jobPath).selectionId, selectionId);
  });

  for (const [state, label] of [[4, "Cancelled"], [7, "Voided"]]) it(`releases an unpaid ${label} reservation without affecting an accepted payment`, async () => {
    const f = fixture(), selectionId = hash("5");
    f.state.state = state;
    await enqueueEscrowFunding(f);
    const jobPath = `escrowFundingJobs/${key(f.record.id)}`, parentPath = `problems/${f.parent.id}`;
    f.db.records.set(jobPath, { ...f.db.records.get(jobPath), selectionRequested: true, selectionId });
    f.db.records.set(parentPath, { ...f.parent, escrowSelection: { proposalId: f.record.id, selectionId, registryAddress: config.address } });
    await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner });
    assert.equal(f.db.records.get(jobPath).selectionRequested, false);
    assert.equal(f.db.records.get(parentPath).escrowSelection, null);
    const paid = fixture({ release: true }); paid.state.state = state;
    paid.db.records.set(parentPath, { ...paid.parent, acceptedProposalId: paid.record.id,
      escrowSelection: { proposalId: paid.record.id, selectionId, registryAddress: config.address } });
    await syncEscrowFunding({ ...paid, proposalId: paid.record.id, uid: owner });
    assert.equal(paid.db.records.get(parentPath).escrowSelection.selectionId, selectionId);
  });

  it("settles and notifies from the scheduled queue after both approvals even when no browser calls sync", async () => {
    const f = fixture(), signedBytes = "0x2345", pendingHash = keccak256(signedBytes), payments = [];
    f.state.state = 1; f.state.ownerApproved = true; f.state.solutionApproved = true;
    f.add(2, fundingDigest(["bytes32", "address", "uint64"], [hash("5"), researcher, nextDay]), "SelectionLocked",
      { selectionId: hash("5"), solutionOwner: researcher, approvalDeadline: nextDay }, hash("d"), 92n, platform);
    await enqueueEscrowFunding(f);
    f.client.simulateContract = async request => { payments.push(request.functionName); };
    f.client.getTransactionCount = async () => 7;
    f.client.sendRawTransaction = async () => pendingHash;
    const getWallet = () => ({ account: { address: platform }, chain: { id: 421614 },
      prepareTransactionRequest: async request => request, signTransaction: async () => signedBytes });
    assert.equal((await sweepEscrowFunding({ ...f, getWallet })).processed, 1);
    assert.deepEqual(payments, ["release"]);
    assert.equal([...f.db.records.keys()].filter(path => path.startsWith("moderationNotifications/")).length, 0);
    const amount = BigInt(f.record.fundingTerms.target) / 2n;
    f.add(8, fundingDigest(["uint256", "bytes32", "uint256", "uint256"], [0n, zero, amount, 0n]), "TrancheReleased",
      { index: 0n, evidenceHash: zero, grossAmount: amount, fee: 0n, netAmount: amount }, pendingHash, 102n, platform);
    f.state.state = 6; f.state.currentTranche = 1n; f.state.totalReleased = amount;
    f.state.ownerApproved = false; f.state.solutionApproved = false;
    f.client.getBlockNumber = async () => 103n;
    const read = f.client.readContract;
    f.client.readContract = async request => request.functionName === "milestoneAt" && Number(request.args[0]) === 0
      ? { ...await read(request), paid: true } : read(request);
    await sweepEscrowFunding({ ...f, getWallet, now: Timestamp.fromMillis(now.toMillis() + 60_000) });
    assert.equal([...f.db.records.keys()].filter(path => path.startsWith("moderationNotifications/")).length, 2);
    assert.equal(f.db.records.get(`escrowFundingSummaries/${key(f.record.id)}`).upfrontReleased, true);
    assert.deepEqual(payments, ["release"]); // Exactly one payout; second run waits for final approvals.
  });
});

describe("serialized platform signing outbox", () => {
  function signingFixture() {
    const f = fixture(), broadcasts = [], prepared = [], serializedTransaction = "0x1234";
    let receipt = null, confirmedNonce = 7;
    f.client.getTransactionCount = async request => request.blockNumber !== undefined ? confirmedNonce : 7;
    f.client.simulateContract = async () => ({});
    f.client.getTransactionReceipt = async () => { if (!receipt) throw new Error("Not found"); return receipt; };
    f.client.sendRawTransaction = async request => {
      const stored = f.db.records.get(`escrowPlatformOutbox/${deploymentKey(config)}`);
      assert.equal(stored.serializedTransaction, request.serializedTransaction);
      broadcasts.push(request.serializedTransaction); throw new Error("RPC timeout after acceptance");
    };
    const getWallet = () => ({ account: { address: platform }, chain: { id: 421614 },
      prepareTransactionRequest: async request => { prepared.push(request); return request; },
      signTransaction: async () => serializedTransaction });
    const action = { address: escrowAddress, abi: config.escrow.escrowAbi, functionName: "release",
      args: [hash("5")], key: "release:first", proposalId: f.record.id };
    return { ...f, action, getWallet, broadcasts, prepared, serializedTransaction,
      setReceipt: value => { receipt = value; }, setConfirmedNonce: value => { confirmedNonce = value; } };
  }

  it("persists signed bytes before broadcast, retries exactly those bytes and serializes concurrent actions", async () => {
    const f = signingFixture();
    const results = await Promise.all([submitPlatformAction(f), submitPlatformAction({ ...f, action: { ...f.action, key: "another" } })]);
    assert.equal(f.prepared.length, 1);
    assert(results.some(result => result.status === "pending"));
    await resumePlatformTransaction(f);
    assert.equal(f.broadcasts.length, 2);
    assert(f.broadcasts.every(bytes => bytes === f.serializedTransaction));
    assert.equal(f.db.records.get(`escrowPlatformOutbox/${deploymentKey(config)}`).transactionHash, keccak256(f.serializedTransaction));
    f.setReceipt({ status: "success", blockNumber: 99n, blockHash: hash("4") });
    await resumePlatformTransaction(f);
    const outbox = f.db.records.get(`escrowPlatformOutbox/${deploymentKey(config)}`);
    assert.equal(outbox.status, "idle"); assert(!outbox.serializedTransaction);
  });

  it("unblocks the nonce after a confirmed replacement, without treating pending nonce advancement as confirmation", async () => {
    const f = signingFixture(); await submitPlatformAction(f);
    assert.equal((await resumePlatformTransaction(f)).status, "pending");
    f.setConfirmedNonce(8);
    assert.equal((await resumePlatformTransaction(f)).status, "replaced");
    assert.equal(f.db.records.get(`escrowPlatformOutbox/${deploymentKey(config)}`).lastOutcome, "replaced");
  });

  it("does not sign with a key belonging to a different platform", async () => {
    const f = signingFixture(), getWallet = () => ({ account: { address: owner } });
    await assert.rejects(submitPlatformAction({ ...f, getWallet }), /signer does not match/);
    assert.equal(f.broadcasts.length, 0);
  });

  it("does not erase a newer moderation projection when an older pause job finishes", async () => {
    const f = fixture(); f.parent.audit = { transactionHash: txHash };
    await queuePostingFundingPause({ ...f, problemId: f.parent.id, record: f.parent });
    const path = `escrowPostingPauseJobs/${key(f.parent.id)}`, old = f.db.records.get(path);
    const read = f.client.readContract;
    f.client.readContract = async request => {
      if (request.functionName !== "postingFundingPaused") return read(request);
      await queuePostingFundingPause({ ...f, problemId: f.parent.id, record: { ...f.parent, moderated: true } });
      return false;
    };
    await reconcilePostingFundingPause({ ...f, job: old });
    assert.equal(f.db.records.get(path).status, "pending");
    assert.notEqual(f.db.records.get(path).revision, old.revision);
  });

  it("keeps a restored posting queued until the older opposite pause transaction confirms, then submits the correction", async () => {
    const f = fixture(); f.parent.audit = { transactionHash: txHash };
    await queuePostingFundingPause({ ...f, problemId: f.parent.id, record: f.parent });
    const path = `escrowPostingPauseJobs/${key(f.parent.id)}`, outboxPath = `escrowPlatformOutbox/${deploymentKey(config)}`;
    const job = f.db.records.get(path), signedBytes = "0x3456", oldHash = hash("e"), sent = [];
    f.db.records.set(outboxPath, { status: "pending", problemId: f.parent.id, proposalId: null,
      actionKey: "old-pause-true", transactionHash: oldHash, serializedTransaction: "0x4567", nonce: 7, signerAddress: platform });
    let paused = false;
    const originalRead = f.client.readContract;
    f.client.readContract = request => request.functionName === "postingFundingPaused" ? Promise.resolve(paused) : originalRead(request);
    f.client.getTransactionCount = async () => 8;
    f.client.simulateContract = async request => { sent.push(request.args[1]); };
    f.client.sendRawTransaction = async () => keccak256(signedBytes);
    const getWallet = () => ({ account: { address: platform }, chain: { id: 421614 },
      prepareTransactionRequest: async request => request, signTransaction: async () => signedBytes });
    await reconcilePostingFundingPause({ ...f, getWallet, job });
    assert.equal(f.db.records.get(path).status, "pending");
    assert.deepEqual(sent, []);
    paused = true;
    f.receipts.set(oldHash, { status: "success", blockNumber: 99n, blockHash: hash("4") });
    await resumePlatformTransaction(f);
    await reconcilePostingFundingPause({ ...f, getWallet, job: f.db.records.get(path), now: Timestamp.fromMillis(now.toMillis() + 60_000) });
    assert.deepEqual(sent, [false]);
    assert.equal(f.db.records.get(outboxPath).transactionHash, keccak256(signedBytes));
    assert.equal(f.db.records.get(path).status, "pending");
  });

  it("invalidates an expired preparing pause lease before marking the matching chain state complete", async () => {
    const f = fixture(); f.parent.audit = { transactionHash: txHash };
    await queuePostingFundingPause({ ...f, problemId: f.parent.id, record: f.parent });
    const path = `escrowPostingPauseJobs/${key(f.parent.id)}`, outboxPath = `escrowPlatformOutbox/${deploymentKey(config)}`;
    f.db.records.set(outboxPath, { status: "preparing", problemId: f.parent.id, leaseToken: "abandoned", leaseUntil: Timestamp.fromMillis(now.toMillis() - 1) });
    const read = f.client.readContract;
    f.client.readContract = request => request.functionName === "postingFundingPaused" ? Promise.resolve(false) : read(request);
    await reconcilePostingFundingPause({ ...f, job: f.db.records.get(path) });
    assert.equal(f.db.records.get(path).status, "complete");
    assert.equal(f.db.records.get(outboxPath).status, "idle");
    assert(!f.db.records.get(outboxPath).leaseToken);
  });
});


it("validates the requested main escrow contribution against the verified remainder", async () => {
  const f = fixture(); f.state.totalDeposited = BigInt(f.record.fundingTerms.target) - 2_000_000n;
  for (const [amount, message] of [["0.50", /at least 1/], ["1.000001", /at most 2 decimal/], ["1.50", /leave only 0.5/], ["2.01", /Only 2/]]) {
    await assert.rejects(prepareEscrowDeposit({ ...f, uid: owner, proposalId: f.record.id, amount }), message);
  }
  assert.equal((await prepareEscrowDeposit({ ...f, uid: owner, proposalId: f.record.id, amount: "1" })).remainingBaseUnits, "2000000");
  f.state.totalDeposited = BigInt(f.record.fundingTerms.target) - 500_000n;
  assert.equal((await prepareEscrowDeposit({ ...f, uid: owner, proposalId: f.record.id, amount: "0.50" })).remainingBaseUnits, "500000");
  f.state.totalDeposited = BigInt(f.record.fundingTerms.target) - 765_433n;
  assert.equal((await prepareEscrowDeposit({ ...f, uid: owner, proposalId: f.record.id, amount: "0.765433" })).remainingBaseUnits, "765433");
});
