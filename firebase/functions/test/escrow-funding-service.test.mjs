import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { encodeAbiParameters, encodeEventTopics, keccak256 } from "viem";
import { escrowClient, escrowConfig, escrowRecord, escrowAddress, owner, researcher, txHash } from "./fixtures/escrowAuditFixture.js";
import { memoryDb } from "./memoryDb.mjs";
import { prepareStoredProposal } from "../proposalAuditPayload.js";
import { fundingDigest } from "../escrowFundingEvents.js";
import { deploymentKey, enqueueEscrowFunding, fundingBlockReason, getEscrowFundingHistory, getEscrowFundingSummary,
  prepareEscrowDeposit, readVerifiedFunding, reconcilePostingFundingPause, resumePlatformTransaction, settlementAction,
  startEscrowSettlement, submitPlatformAction, syncEscrowFunding, queuePostingFundingPause } from "../escrowFunding.js";
import { sweepEscrowFunding } from "../escrowFunding.js";

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
    yesWeight: 0n, approvalDeadline: nextDay, expiresAt: 2000000000n, platformSigner: platform, active: true };
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
    if (request.functionName === "fundingAnchorCount") return BigInt(anchors.length);
    if (request.functionName === "isFundingActive") return state.active;
    if (request.functionName === "platformSigner") return platform;
    if (request.functionName === "outstandingBalance") return state.totalDeposited - state.totalReleased - state.totalRefunded;
    if (request.functionName in state && request.address === escrowAddress) return state[request.functionName];
    const result = await originalRead(request);
    if (request.functionName === "milestoneAt") return { ...result, evidenceHash: Number(request.args[0]) === 0 ? zero : hash("8"),
      fee: 0n, paid: release && Number(request.args[0]) === 0 };
    return result;
  };
  return { db, client, config, record, parent, expected, state, receipts, anchors, reads, ranges, add, now };
}

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

  it("indexes original creation even when audit.transactionHash points at a later proposal amendment", async () => {
    const f = fixture(), amendment = hash("a");
    f.receipts.set(amendment, { to: config.address, status: "success", blockNumber: 99n, logs: [], transactionHash: amendment });
    f.record.audit.transactionHash = amendment;
    const result = await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner });
    assert.equal(f.ranges[0].fromBlock, 80n);
    assert.equal(result.reconciliation.anchors, 2);
  });

  it("persists a bounded scan cursor and publishes no summary until the complete registry history is reconciled", async () => {
    const f = fixture(); f.client.getBlockNumber = async () => 30100n;
    let result = await syncEscrowFunding({ ...f, proposalId: f.record.id, uid: owner });
    assert.equal(result.reconciliation.complete, false); assert.equal(result.summary, null);
    assert.equal(f.ranges[0].toBlock - f.ranges[0].fromBlock + 1n, 10000n);
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
    const dashboard = await getEscrowFundingSummary({ db: f.db, config, uid: owner });
    assert.equal(dashboard.items.length, 1); assert.equal(dashboard.items[0].upfrontReleased, true);
    assert.equal(f.db.records.get(`problems/${f.record.problemId}`).acceptedProposalId, f.record.id);
    assert.equal(f.db.records.get(`proposals/${f.record.id}`).status, "accepted");
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
