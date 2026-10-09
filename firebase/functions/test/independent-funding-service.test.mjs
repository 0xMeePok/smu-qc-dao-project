import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256 } from "viem";
import main from "../auditRegistry.contract.json" with { type: "json" };
import independent from "../independentFunding.contract.json" with { type: "json" };
import { prepareStoredProposal } from "../proposalAuditPayload.js";
import { memoryDb } from "./memoryDb.mjs";
import { createFundingApproach, decideFundingApproach } from "../fundingApproach.js";
import { assertIndependentPublicationUnlocked, getIndependentFundingState, hashIndependentFundingEvidence,
  independentFundingKey, prepareIndependentFundingAction, readIndependentFundingPortfolio,
  reconcileIndependentFunding, syncIndependentFunding } from "../independentFunding.js";
import { enqueueIndependentFundingCancellation } from "../independentFundingModeration.js";
import { reconcileModerationVoids } from "../escrowFunding.js";

const address = digit => `0x${digit.repeat(40)}`, hash = digit => `0x${digit.repeat(64)}`;
const researcher = address("a"), funder = address("b"), outsider = address("c"), platform = address("d");
const publicationHash = hash("1"), depositHash = hash("5"), now = Timestamp.fromMillis(1_900_000_000_000);
function fixture({ activated = true } = {}) {
  const config = { ...main, address: address("7"), escrow: { ...main.escrow, factoryAddress: address("8"),
    tokens: [{ address: address("e"), symbol: "USDC", decimals: 6 }] } };
  config.independentFunding = { ...independent, enabled: true, chainId: config.chainId, registryAddress: config.address,
    factoryAddress: address("9"), reviewDays: 30, tokens: config.escrow.tokens };
  const escrow = address("f");
  const record = { id: "independent-service", proposalKind: "independent", researcherId: researcher,
    title: "Quantum routing", summary: "Routing with quantum-adjacent research", methodology: "Hybrid annealing",
    category: "quantum-adjacent", maturity: "pilot", addressedProblems: "Routing", team: "Research team",
    amount: 2, currency: "USDC", expiresAt: Timestamp.fromMillis(now.toMillis() + 30 * 864e5),
    status: "submitted", attachments: [], fundingTerms: { reviewWindows: [604800, 604800] },
    audit: { schemaVersion: 2, chainId: config.chainId, transactionHash: publicationHash, status: "confirmed" } };
  const prepared = prepareStoredProposal(record, { registryConfig: config });
  const expiresAt = BigInt(record.expiresAt.toMillis() / 1000);
  const termsHash = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "address" },
    { type: "uint256" }, { type: "uint64" }, { type: "uint32" }],
  [prepared.entityId, researcher, config.escrow.tokens[0].address, 2_000_000n, expiresAt, 7]));
  const state = { state: 0, listingId: prepared.entityId, researcher, token: config.escrow.tokens[0].address,
    tokenDecimals: 6, fundingTarget: 2_000_000n, expiresAt, reviewDays: 7, completionDeadline: 0n,
    termsHash, listingContentHash: prepared.contentHash, platformSigner: platform,
    tokenRegistry: config.escrow.factoryAddress, auditRegistry: config.address, factory: config.independentFunding.factoryAddress,
    feeBps: 25, feeRecipient: platform, totalDeposited: 1_000_000n, totalReleased: 0n, totalRefunded: 0n, feePaid: 0n,
    outstandingBalance: 1_000_000n, refundPool: 0n, refundsEnabled: false, evidenceHash: hash("0"), evidenceVersion: 0n,
    yesWeight: 0n, noWeight: 0n, funderCount: 1n, contribution: 1_000_000n, refunded: 0n, claimable: 0n,
    hasVoted: false, votedApprove: false, active: true, depositsOpen: true, canAccept: false, canDecline: false,
    canSubmitEvidence: false, canVote: false, canReleaseCompletion: false };
  const db = memoryDb({ [`proposals/${record.id}`]: record,
    [`users/${researcher}`]: { role: 0 }, [`users/${funder}`]: { role: 3 },
    [`users/${outsider}`]: { role: 2 }, [`users/${platform}`]: { role: 1 } });
  const originalCollection = db.collection;
  db.collection = name => {
    const collection = originalCollection(name), originalDoc = collection.doc;
    collection.doc = id => { const ref = originalDoc(id); ref.collection = child => db.collection(`${ref.path}/${child}`); return ref; };
    return collection;
  };
  const calls = [], simulations = [], receipts = new Map(), transactions = new Map();
  transactions.set(publicationHash, { hash: publicationHash, from: researcher, to: config.address, chainId: config.chainId,
    blockNumber: 88n, blockHash: hash("8"), input: encodeFunctionData({ abi: config.abi, functionName: "commitOpportunity", args: prepared.args }) });
  receipts.set(publicationHash, { transactionHash: publicationHash, status: "success", blockNumber: 88n, blockHash: hash("8"), logs: [] });
  const eventName = "Deposited", eventArgs = { funder, amount: 1_000_000n, totalDeposited: 1_000_000n, contribution: 1_000_000n };
  const event = config.independentFunding.escrowAbi.find(item => item.type === "event" && item.name === eventName);
  const dataInputs = event.inputs.filter(input => !input.indexed);
  receipts.set(depositHash, { transactionHash: depositHash, status: "success", blockNumber: 90n, blockHash: hash("6"),
    logs: [{ address: escrow, transactionHash: depositHash, logIndex: 0,
      topics: encodeEventTopics({ abi: config.independentFunding.escrowAbi, eventName, args: eventArgs }),
      data: encodeAbiParameters(dataInputs, dataInputs.map(input => eventArgs[input.name])) }] });
  transactions.set(depositHash, { hash: depositHash, from: funder, to: escrow, chainId: config.chainId,
    blockNumber: 90n, blockHash: hash("6"), input: encodeFunctionData({ abi: config.independentFunding.escrowAbi, functionName: "deposit", args: [1_000_000n] }) });
  const client = { getChainId: async () => config.chainId, getBlockNumber: async () => 101n,
    getTransaction: async ({ hash: value }) => transactions.get(value),
    getTransactionReceipt: async ({ hash: value }) => receipts.get(value),
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(now.toMillis() / 1000),
      hash: blockNumber === 88n ? hash("8") : blockNumber === 90n ? hash("6") : hash("4"),
      parentHash: blockNumber === 89n ? hash("8") : blockNumber === 91n ? hash("6") : hash("3") }),
    getLogs: async () => { throw new Error("Independent funding must never scan historical logs"); },
    simulateContract: async request => { simulations.push(request); return { request }; },
    readContract: async request => {
      calls.push(request);
      if (request.address === config.independentFunding.factoryAddress) {
        return { auditRegistry: config.address, tokenRegistry: config.escrow.factoryAddress, platformSigner: platform,
          escrowForListing: activated ? escrow : address("0") }[request.functionName];
      }
      if (request.address === config.address && request.functionName === "getOpportunity") return {
        owner: researcher, kind: 2, contentHash: prepared.contentHash, expiresAt, withdrawn: false };
      if (request.address === escrow && request.functionName === "getState") return { ...state,
        contribution: request.args[0] === funder ? state.contribution : 0n,
        claimable: request.args[0] === funder ? state.claimable : 0n };
      throw new Error(`Unexpected fixture read ${request.functionName}`);
    } };
  const options = uid => ({ db, client, config, uid, proposalId: record.id, now });
  return { db, client, config, record, prepared, state, escrow, calls, simulations, receipts, transactions, options };
}

describe("independent funding backend authorization and preparation", () => {
  it("verifies a pending publication before immediate activation and preserves the form's seven-day review window", async () => {
    const f = fixture({ activated: false }); f.record.audit.status = "pending";
    const action = await prepareIndependentFundingAction({ ...f.options(researcher), action: "activate" });
    assert.equal(action.functionName, "createEscrow"); assert.equal(action.args[3], 7);
    assert.equal(action.args[2], "2000000");
    assert.equal(f.simulations.length, 1);
    assert(f.calls.every(call => call.functionName !== "getProposal"));
  });

  it("prepares a fresh-wallet deposit before allowance without transfer simulation", async () => {
    const f = fixture(); f.client.simulateContract = async () => { throw new Error("ERC20 allowance is zero"); };
    const action = await prepareIndependentFundingAction({ ...f.options(funder), action: "deposit", amount: "1" });
    assert.equal(action.amountBaseUnits, "1000000"); assert.deepEqual(action.args, ["1000000"]);
    for (const amount of ["0", "-1", "1.0000001", "0.0000001", "1e-6", "2"]) {
      await assert.rejects(prepareIndependentFundingAction({ ...f.options(funder), action: "deposit", amount }));
    }
  });

  it("rejects activation below two token base units or with unsupported decimal precision", async () => {
    const f = fixture({ activated: false });
    for (const amount of [0.000001, "0.0000001"]) {
      f.record.amount = amount;
      await assert.rejects(prepareIndependentFundingAction({ ...f.options(researcher), action: "activate" }), /base units|decimal places/);
    }
  });

  it("rejects suspended members, evaluators depositing, self-funding and non-author acceptance", async () => {
    const f = fixture();
    await assert.rejects(prepareIndependentFundingAction({ ...f.options(outsider), action: "deposit", amount: "1" }), /not available/);
    await assert.rejects(prepareIndependentFundingAction({ ...f.options(researcher), action: "deposit", amount: "1" }), /not available/);
    f.state.canAccept = true;
    await assert.rejects(prepareIndependentFundingAction({ ...f.options(funder), action: "accept" }), /not available/);
    f.db.records.set(`users/${funder}`, { role: 3, suspended: true });
    await assert.rejects(getIndependentFundingState(f.options(funder)), /active member/);
  });

  it("reports an unconfigured workflow without RPC and rejects wrong-chain state", async () => {
    const f = fixture(); f.config.independentFunding.enabled = false;
    f.client.getChainId = async () => { throw new Error("RPC must not be called"); };
    assert.equal((await getIndependentFundingState(f.options(funder))).configured, false);
    f.config.independentFunding.enabled = true;
    f.client.getChainId = async () => 1;
    await assert.rejects(getIndependentFundingState(f.options(funder)), /configured Arbitrum/);
  });

  it("requires canonical mapped escrow identity and a consistent frozen terms hash", async () => {
    for (const patch of [{ factory: address("2") }, { tokenRegistry: address("2") }, { auditRegistry: address("2") },
      { researcher: address("2") }, { listingId: hash("2") }, { platformSigner: address("2") },
      { fundingTarget: 3_000_000n }, { tokenDecimals: 18 }, { termsHash: hash("2") }]) {
      const f = fixture(); Object.assign(f.state, patch);
      await assert.rejects(getIndependentFundingState(f.options(funder)), /terms|match|verified/);
    }
  });

  it("does not confirm inconsistent balances or vote weights", async () => {
    for (const patch of [{ outstandingBalance: 2n }, { feePaid: 1n }, { yesWeight: 2_000_000n }, { totalDeposited: 3_000_000n }]) {
      const f = fixture(); Object.assign(f.state, patch);
      await assert.rejects(getIndependentFundingState(f.options(funder)), /reconcile/);
    }
  });

  it("keeps removed and metadata-drifted listings refund-only without exposing evidence", async () => {
    const f = fixture(); Object.assign(f.state, { state: 5, refundsEnabled: true, claimable: 1_000_000n, depositsOpen: false });
    Object.assign(f.record, { title: "A changed stored title", amount: 99, moderationStatus: "removed", status: "moderated_removed" });
    const result = await getIndependentFundingState(f.options(funder));
    assert.equal(result.hidden, true); assert.equal(result.refundOnly, true);
    assert.equal(result.summary.title, "Removed independent listing"); assert.equal(result.summary.fundingTarget, "2000000");
    assert.equal(result.actions.claimRefund, true); assert.equal(result.actions.deposit, false);
    assert.equal(result.evidence, null);
    await assert.rejects(getIndependentFundingState(f.options(outsider)), /no refund/);
  });

  it("uses completion expiry claims without offering a redundant expire transaction", async () => {
    const f = fixture(); Object.assign(f.state, { state: 4, claimable: 1_000_000n, refundsEnabled: true, depositsOpen: false });
    const result = await getIndependentFundingState(f.options(funder));
    assert.equal(result.actions.expire, false); assert.equal(result.actions.claimRefund, true);
    assert.equal((await prepareIndependentFundingAction({ ...f.options(funder), action: "claimRefund" })).functionName, "claimRefund");
  });

  it("stages immutable matching HTTPS evidence and requires review of its current version for voting", async () => {
    const f = fixture(); Object.assign(f.state, { state: 1, canSubmitEvidence: true, canVote: true, depositsOpen: false });
    const evidence = { summary: "Reproducible delivery results", url: "https://example.com/evidence" };
    const evidenceHash = hashIndependentFundingEvidence(evidence);
    await prepareIndependentFundingAction({ ...f.options(researcher), action: "submitEvidence", evidence, evidenceHash });
    assert.equal((await getIndependentFundingState(f.options(funder))).evidence, null, "staging alone is not confirmed evidence");
    f.state.evidenceHash = evidenceHash; f.state.evidenceVersion = 2n;
    const result = await getIndependentFundingState(f.options(funder));
    assert.equal(result.evidence.hash, evidenceHash); assert.equal(result.actions.vote, true);
    const vote = await prepareIndependentFundingAction({ ...f.options(funder), action: "vote", evidenceHash, approve: true });
    assert.deepEqual(vote.args, ["2", evidenceHash, true]);
    await assert.rejects(prepareIndependentFundingAction({ ...f.options(funder), action: "vote", evidenceHash: hash("2"), approve: true }), /current evidence/);
    await assert.rejects(prepareIndependentFundingAction({ ...f.options(researcher), action: "submitEvidence", evidence: { ...evidence, url: "javascript:alert(1)" }, evidenceHash }), /HTTPS/);
  });

  it("requires a readable decline reason and locks a changed publication even before the cache projection exists", async () => {
    const f = fixture(); f.state.canDecline = true;
    await assert.rejects(prepareIndependentFundingAction({ ...f.options(researcher), action: "decline" }), /decline reason/);
    assert.equal((await prepareIndependentFundingAction({ ...f.options(researcher), action: "decline", reason: "Cannot deliver in the agreed schedule" })).functionName, "declineFunding");
    await assertIndependentPublicationUnlocked({ ...f.options(researcher), record: f.record });
    await assert.rejects(assertIndependentPublicationUnlocked({ ...f.options(researcher), record: { ...f.record, title: "Correction" } }), /immutable/);
    await assert.rejects(assertIndependentPublicationUnlocked({ ...f.options(researcher), record: { ...f.record,
      fundingTerms: { reviewWindows: [86400, 86400] } } }), /immutable/);
  });

  it("keeps legacy approaches read-only when the independent deployment is enabled", async () => {
    const config = { independentFunding: { enabled: true } };
    await assert.rejects(createFundingApproach({ config }), /read-only/);
    await assert.rejects(decideFundingApproach({ config }), /read-only/);
  });
});

describe("independent funding receipt synchronization and bounded caches", () => {
  it("syncs one canonical wallet receipt idempotently without any historical log scan", async () => {
    const f = fixture();
    await syncIndependentFunding({ ...f.options(funder), transactionHash: depositHash });
    await syncIndependentFunding({ ...f.options(funder), transactionHash: depositHash });
    const key = independentFundingKey(f.config, f.record.id);
    assert.equal(f.db.records.get(`independentFundingSummaries/${key}`).fundingTarget, "2000000");
    assert.equal(f.db.records.get(`independentFundingPositions/${key}_${funder}`).deposited, "1000000");
    assert.equal(f.db.records.get(`proposals/${f.record.id}`).independentFunding.locked, true);
    assert.equal([...f.db.records.keys()].filter(path => path.startsWith("independentFundingEvents/")).length, 1);
    assert.equal([...f.db.records.keys()].filter(path => path.startsWith("audits/")).length, 1);
    assert(f.calls.every(call => typeof call.blockNumber === "bigint"));
  });

  it("rejects wrong actor, destination, chain, reverted and unconfirmed funding receipts", async () => {
    for (const patch of [{ from: outsider }, { to: outsider }, { chainId: 1 }, { blockHash: hash("2") }, { blockNumber: 101n }]) {
      const f = fixture(); Object.assign(f.transactions.get(depositHash), patch);
      await assert.rejects(syncIndependentFunding({ ...f.options(funder), transactionHash: depositHash }), /confirmed action/);
      assert.equal([...f.db.records.keys()].filter(path => path.startsWith("audits/")).length, 0);
    }
    const f = fixture(); f.receipts.get(depositHash).status = "reverted";
    await assert.rejects(syncIndependentFunding({ ...f.options(funder), transactionHash: depositHash }));
  });

  it("rejects reorganized canonical receipts and bounds event processing", async () => {
    const f = fixture(), originalBlock = f.client.getBlock;
    f.client.getBlock = async request => ({ ...await originalBlock(request), parentHash: hash("0") });
    await assert.rejects(syncIndependentFunding({ ...f.options(funder), transactionHash: depositHash }), /canonical confirmations/);
    f.client.getBlock = originalBlock;
    f.receipts.get(depositHash).logs = Array.from({ length: 65 }, () => ({}));
    await assert.rejects(syncIndependentFunding({ ...f.options(funder), transactionHash: depositHash }), /bounded event budget/);
  });

  it("does not overwrite a newer financial cache with an older confirmed snapshot", async () => {
    const f = fixture(); const key = independentFundingKey(f.config, f.record.id);
    f.db.records.set(`independentFundingSummaries/${key}`, { blockNumber: 102, totalReleased: "1000000" });
    await syncIndependentFunding(f.options(funder));
    assert.equal(f.db.records.get(`independentFundingSummaries/${key}`).totalReleased, "1000000");
  });

  it("labels cached per-wallet allocations stale after another actor changes the summary", async () => {
    const f = fixture(); await syncIndependentFunding(f.options(funder));
    const key = independentFundingKey(f.config, f.record.id), path = `independentFundingSummaries/${key}`;
    f.db.records.set(path, { ...f.db.records.get(path), blockNumber: 101, totalReleased: "1000000" });
    f.client.getChainId = async () => { throw new Error("Portfolio must not poll RPC"); };
    const result = await readIndependentFundingPortfolio(f.options(funder));
    assert.equal(result.snapshotOnly, true); assert.equal(result.items[0].stale, true);
    assert.equal(result.items[0].wallet.claimable, null); assert.equal(result.items[0].wallet.deposited, "1000000");
  });

  it("queues independent removals idempotently without depending on legacy fundingTerms", async () => {
    const f = fixture(); delete f.record.fundingTerms;
    f.db.records.set("moderationEvents/removal1", { action: "remove", contentType: "proposal", contentId: f.record.id, reason: "off-topic" });
    await enqueueIndependentFundingCancellation({ db: f.db, contentType: "proposal", contentId: f.record.id, eventId: "removal1", now });
    await enqueueIndependentFundingCancellation({ db: f.db, contentType: "proposal", contentId: f.record.id, eventId: "removal1", now });
    assert.equal([...f.db.records.keys()].filter(path => path.startsWith("independentFundingCancellationJobs/")).length, 1);
    assert.equal((await reconcileIndependentFunding({ ...f.options(funder), config: { ...f.config, independentFunding: { enabled: false } } })).processed, 0);
  });

  it("performs no RPC work when there are no due independent jobs", async () => {
    const f = fixture(); f.client.getBlockNumber = async () => { throw new Error("No RPC polling for idle jobs"); };
    assert.deepEqual(await reconcileIndependentFunding(f.options(funder)), { processed: 0 });
  });

  it("routes old independent moderation jobs into the dedicated cancellation queue without probing main escrow", async () => {
    const f = fixture();
    f.db.records.set("moderationEvents/removal1", { action: "remove", contentType: "proposal", contentId: f.record.id, reason: "misleading" });
    f.db.records.set("escrowModerationVoidJobs/old", { proposalId: f.record.id, eventId: "removal1", reason: "misleading",
      status: "pending", nextAttemptAt: now });
    f.client.getBlockNumber = async () => { throw new Error("Do not probe a nonexistent main child escrow"); };
    await reconcileModerationVoids({ ...f.options(funder), now });
    assert.equal(f.db.records.get("escrowModerationVoidJobs/old").status, "skipped");
    assert.equal([...f.db.records.keys()].filter(path => path.startsWith("independentFundingCancellationJobs/")).length, 1);
  });

  it("records a confirmed terminal cancellation without submitting another platform transaction", async () => {
    const f = fixture(); Object.assign(f.record, { moderationStatus: "removed", status: "moderated_removed" });
    Object.assign(f.state, { state: 5, refundsEnabled: true, depositsOpen: false });
    f.db.records.set("moderationEvents/removal1", { action: "remove", contentType: "proposal", contentId: f.record.id });
    await enqueueIndependentFundingCancellation({ db: f.db, contentType: "proposal", contentId: f.record.id, eventId: "removal1", now });
    const result = await reconcileIndependentFunding({ ...f.options(funder), getWallet: () => { throw new Error("Do not sign a duplicate cancellation"); } });
    assert.equal(result.processed, 1);
    assert.equal(f.db.records.get(`independentFundingCancellationJobs/removal1_${f.record.id}`).status, "complete");
    assert.equal(f.db.records.get("moderationEvents/removal1").independentFundingCancellation.status, "complete");
  });

  it("persists signed cancellation bytes before an uncertain send and clears a reverted receipt for retry", async () => {
    const f = fixture(); Object.assign(f.record, { moderationStatus: "removed", status: "moderated_removed" });
    f.db.records.set("moderationEvents/removal1", { action: "remove", contentType: "proposal", contentId: f.record.id });
    await enqueueIndependentFundingCancellation({ db: f.db, contentType: "proposal", contentId: f.record.id, eventId: "removal1", now });
    const read = f.client.readContract;
    f.client.readContract = async request => request.address === f.config.escrow.factoryAddress && request.functionName === "platformSigner"
      ? platform : read(request);
    f.client.getTransactionCount = async () => 0;
    f.client.sendRawTransaction = async () => { throw new Error("Uncertain RPC send after acceptance"); };
    const getWallet = async () => ({ account: { address: platform }, chain: { id: f.config.chainId },
      prepareTransactionRequest: async request => request, signTransaction: async () => "0x1234" });
    await reconcileIndependentFunding({ ...f.options(funder), getWallet });
    const jobPath = `independentFundingCancellationJobs/removal1_${f.record.id}`;
    const pendingHash = f.db.records.get(jobPath).transactionHash;
    assert.equal(pendingHash, keccak256("0x1234"));
    const outboxPath = `escrowPlatformOutbox/${f.config.chainId}_${f.config.address}`;
    assert.equal(f.db.records.get(outboxPath).serializedTransaction, "0x1234");
    f.receipts.set(pendingHash, { transactionHash: pendingHash, status: "reverted", blockNumber: 90n, blockHash: hash("6") });
    f.transactions.set(pendingHash, { hash: pendingHash, from: platform, to: f.escrow, chainId: f.config.chainId,
      blockNumber: 90n, blockHash: hash("6"), input: encodeFunctionData({ abi: f.config.independentFunding.escrowAbi, functionName: "adminCancel", args: [hash("2")] }) });
    await reconcileIndependentFunding({ ...f.options(funder), now: Timestamp.fromMillis(now.toMillis() + 60_000), getWallet });
    assert.equal(f.db.records.get(jobPath).status, "pending");
    assert.equal(f.db.records.get(jobPath).transactionHash, null);
    assert.equal(f.db.records.get(outboxPath).status, "idle");
  });
});


it("loads independent portfolio records concurrently with bounded reads and stable masking", async () => {
  const f = fixture(); await syncIndependentFunding(f.options(funder));
  const key = independentFundingKey(f.config, f.record.id);
  const savedSummary = f.db.records.get(`independentFundingSummaries/${key}`);
  const savedPosition = [...f.db.records.entries()].find(([path]) => path.startsWith("independentFundingPositions/"))[1];
  for (let index = 0; index < 8; index++) {
    const proposalId = `portfolio-${index}`;
    f.db.records.set(`proposals/${proposalId}`, { ...f.record, id: proposalId, title: `Listing ${index}`,
      ...(index === 2 ? { moderationStatus: "removed" } : {}) });
    f.db.records.set(`independentFundingSummaries/${independentFundingKey(f.config, proposalId)}`, { ...savedSummary, proposalId });
    f.db.records.set(`independentFundingPositions/position-${index}`, { ...savedPosition, proposalId });
  }
  f.client.getChainId = async () => { throw new Error("Portfolio must not call RPC"); };
  const collection = f.db.collection;
  let active = 0, maximum = 0;
  f.db.collection = name => {
    const value = collection(name);
    if (!["proposals", "independentFundingSummaries"].includes(name)) return value;
    const doc = value.doc;
    value.doc = id => {
      const ref = doc(id), get = ref.get;
      ref.get = async () => {
        active++; maximum = Math.max(maximum, active);
        try { await new Promise(resolve => setTimeout(resolve, 1)); return await get(); }
        finally { active--; }
      };
      return ref;
    };
    return value;
  };
  const result = await readIndependentFundingPortfolio(f.options(funder));
  assert(maximum > 2); assert(maximum <= 8);
  assert.deepEqual(result.items.map(row => row.proposalId), [f.record.id, ...Array.from({ length: 8 }, (_, index) => `portfolio-${index}`)]);
  assert.equal(result.items.find(row => row.proposalId === "portfolio-2").title, "Removed independent listing");
});


it("reports the exact remaining independent contribution separately from invalid positive amounts", async () => {
  const f = fixture();
  Object.assign(f.state, { totalDeposited: 1_234_567n, outstandingBalance: 1_234_567n });
  await assert.rejects(prepareIndependentFundingAction({ ...f.options(funder), action: "deposit", amount: "0.765434" }),
    error => error.code === "invalid-argument" && error.message === "Only 0.765433 USDC is still needed. Enter this amount or less.");
  const exact = await prepareIndependentFundingAction({ ...f.options(funder), action: "deposit", amount: "0.765433" });
  assert.equal(exact.amountBaseUnits, "765433");
  await assert.rejects(prepareIndependentFundingAction({ ...f.options(funder), action: "deposit", amount: "0" }),
    error => error.code === "invalid-argument" && error.message === "Enter a contribution greater than zero.");
  await assert.rejects(prepareIndependentFundingAction({ ...f.options(funder), action: "deposit", amount: "0.0000001" }), /supported decimal places/);
  assert.equal(f.simulations.length, 0);
});
