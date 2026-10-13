import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { encodeAbiParameters, encodeEventTopics, keccak256 } from "viem";
import { memoryDb } from "./memoryDb.mjs";
import { escrowClient, escrowConfig, escrowRecord, escrowAddress, owner, researcher, blockHash } from "./fixtures/escrowAuditFixture.js";
import { prepareStoredProposal } from "../proposalAuditPayload.js";
import { ADMIN_CANCELLATIONS, adminCancellationBlockReason, adminCancellationReasonHash,
  getEscrowAdminCancellation, reconcileEscrowAdminCancellation, startEscrowAdminCancellation,
  sweepEscrowAdminCancellations } from "../escrowAdminCancellation.js";
import { deploymentKey, PLATFORM_OUTBOX, resumePlatformTransaction } from "../escrowFunding.js";

const admin = `0x${"7".repeat(40)}`, signer = `0x${"9".repeat(40)}`, otherFunder = `0x${"8".repeat(40)}`;
const hash = digit => `0x${digit.repeat(64)}`;
const now = Timestamp.fromMillis(1900000000000), signed = "0x1234", signedHash = keccak256(signed);
function fixture({ grant = false } = {}) {
  const record = escrowRecord(); record.audit.status = "confirmed";
  if (grant) record.opportunityType = "open-funding";
  const config = escrowConfig, expected = prepareStoredProposal(record, { registryConfig: config });
  const parent = { id: record.problemId, ownerId: owner, status: "submitted", title: "Posting", expiresAt: Timestamp.fromMillis(2000000000000) };
  if (grant) parent.opportunityType = "open-funding";
  const id = `${deploymentKey(config)}_${record.id}`;
  const db = memoryDb({ [`users/${admin}`]: { role: 1 }, [`users/${owner}`]: { role: 0 },
    [`users/${researcher}`]: { role: 0 }, [`proposals/${record.id}`]: record, [`problems/${record.problemId}`]: parent });
  const client = escrowClient(record), original = client.readContract, reads = [], receipts = new Map(), signedTransactions = [];
  const state = { state: 0, totalDeposited: BigInt(record.fundingTerms.target), totalReleased: 0n, totalRefunded: 0n,
    currentTranche: 0n, selectionId: hash("0"), ownerApproved: false, solutionApproved: false,
    yesWeight: 0n, approvalDeadline: 0n, expiresAt: 2000000000n, platformSigner: signer,
    refundsEnabled: false, refundAvailableAt: 0n, isAdmin: true };
  client.getChainId = async () => 421614;
  client.getBlockNumber = async () => 101n;
  client.getBlock = async () => ({ hash: blockHash, timestamp: 1900000000n });
  client.getTransactionCount = async () => 0;
  client.getTransactionReceipt = async ({ hash: tx }) => { if (!receipts.has(tx)) throw new Error("Pending"); return receipts.get(tx); };
  client.sendRawTransaction = async () => signedHash;
  client.simulateContract = async request => ({ request });
  client.readContract = async request => {
    reads.push(request);
    if (request.functionName === "isEscrowAdmin") return state.isAdmin;
    if (request.functionName === "platformSigner") return signer;
    if (request.functionName === "isFundingActive") return true;
    if (request.functionName === "isFundingInvalidated") return false;
    if (request.functionName === "fundingAnchorCount") return 2n;
    if (request.functionName === "balanceOf") return state.custodyBalance ?? state.totalDeposited - state.totalReleased - state.totalRefunded;
    if (request.functionName === "outstandingBalance") return state.totalDeposited - state.totalReleased - state.totalRefunded;
    if (request.address === escrowAddress && request.functionName in state) return state[request.functionName];
    const value = await original(request);
    return request.functionName === "milestoneAt" ? { ...value, paid: false, evidenceHash: hash("0") } : value;
  };
  const getWallet = async () => ({ account: { address: signer }, chain: { id: 421614 },
    prepareTransactionRequest: async request => request,
    signTransaction: async request => { signedTransactions.push(request); return signed; } });
  const options = { db, client, config, getWallet, uid: admin, proposalId: record.id, reason: "Posting created in error", requestId: "cancel-request", now };
  function log(abi, address, eventName, args, logIndex) {
    const spec = abi.find(item => item.type === "event" && item.name === eventName), data = spec.inputs.filter(item => !item.indexed);
    return { address, logIndex, topics: encodeEventTopics({ abi, eventName, args }),
      data: encodeAbiParameters(data, data.map(item => args[item.name])) };
  }
  function confirm({ canonical = true, success = true, matchingReason = true } = {}) {
    const job = db.records.get(`${ADMIN_CANCELLATIONS}/${id}`), digest = matchingReason ? job.reasonHash : hash("f");
    receipts.set(signedHash, { transactionHash: signedHash, status: success ? "success" : "reverted",
      blockNumber: 99n, blockHash: canonical ? blockHash : hash("2"), logs: success ? [
        log(config.abi, config.address, "FundingEventAnchored", { proposalId: expected.entityId, escrow: escrowAddress,
          eventType: 9, digest, actor: signer, timestamp: 1900000000n }, 1),
        log(config.escrow.escrowAbi, escrowAddress, "EscrowVoided", { admin: signer, reasonHash: digest, refundPool: state.totalDeposited }, 0),
      ] : [] });
    if (success) { state.state = 7; state.refundsEnabled = true; state.refundAvailableAt = 1900000000n; }
  }
  return { ...options, options, id, record, parent, state, reads, receipts, signedTransactions, confirm, expected };
}

describe("administrator escrow cancellation", () => {
  it("requires an active administrator and mandatory bounded reason before touching the signer", async () => {
    const f = fixture();
    await assert.rejects(startEscrowAdminCancellation({ ...f.options, uid: owner }), { code: "permission-denied" });
    f.db.records.set(`users/${admin}`, { role: 1, suspended: true });
    await assert.rejects(startEscrowAdminCancellation(f.options), { code: "permission-denied" });
    f.db.records.set(`users/${admin}`, { role: 1 });
    for (const reason of ["  ", "x".repeat(2001), null]) {
      await assert.rejects(startEscrowAdminCancellation({ ...f.options, reason }), { code: "invalid-argument" });
    }
    assert.equal(f.reads.length, 0); assert.equal(f.signedTransactions.length, 0);
  });

  it("blocks any prior release, partial custody, closed escrows and grant reservations", async () => {
    const f = fixture();
    f.state.totalReleased = 1n;
    await assert.rejects(startEscrowAdminCancellation(f.options), { code: "failed-precondition" });
    f.state.totalReleased = 0n; f.state.custodyBalance = 1n;
    await assert.rejects(startEscrowAdminCancellation(f.options), { code: "failed-precondition" });
    f.state.custodyBalance = f.state.totalDeposited; f.state.state = 2;
    await assert.rejects(startEscrowAdminCancellation(f.options), { code: "failed-precondition" });
    const grant = fixture({ grant: true }); grant.state.totalDeposited = 0n;
    await assert.rejects(startEscrowAdminCancellation(grant.options), /grant pool/);
    assert.equal(f.signedTransactions.length, 0);
    assert.match(adminCancellationBlockReason({ totalReleased: "1", state: "Active" }), /after any payment/);
  });

  it("reads canonical eligibility and marks the durable request pending without inventing refunds", async () => {
    const f = fixture();
    const initial = await getEscrowAdminCancellation(f.options);
    assert.equal(initial.canCancel, true); assert.equal(initial.request, null);
    const result = await startEscrowAdminCancellation(f.options);
    assert.equal(result.status, "pending"); assert.equal(result.request.txHash, signedHash);
    assert.equal(result.request.actor, admin); assert.equal(result.request.refundAmountBaseUnits, null);
    assert.equal(f.db.records.get(`escrowFundingJobs/${f.id}`).adminCancellationStatus, "pending");
    assert.equal(f.db.records.get(`proposals/${f.proposalId}`).escrowAdminCancellation.status, "pending");
    assert.equal([...f.db.records.keys()].filter(key => key.startsWith("audits/")).length, 0);
    assert.equal([...f.db.records.keys()].filter(key => key.startsWith("moderationNotifications/")).length, 0);
    assert.equal(f.signedTransactions.length, 1);
    await startEscrowAdminCancellation(f.options);
    assert.equal(f.signedTransactions.length, 1, "retry does not sign another cancellation");
    await assert.rejects(startEscrowAdminCancellation({ ...f.options, reason: "Change reason" }), { code: "already-exists" });
    assert.equal((await getEscrowAdminCancellation(f.options)).canCancel, false);
  });

  it("requires the allowlisted platform signer and refuses a pending platform payout", async () => {
    const f = fixture(); f.state.isAdmin = false;
    await assert.rejects(startEscrowAdminCancellation(f.options), /allowlisted/);
    f.state.isAdmin = true;
    f.db.records.set(`${PLATFORM_OUTBOX}/${deploymentKey(f.config)}`, { proposalId: f.proposalId,
      functionName: "releaseMilestone", transactionHash: hash("e"), status: "pending" });
    await assert.rejects(startEscrowAdminCancellation(f.options), /already being confirmed/);
    assert.equal(f.signedTransactions.length, 0);
  });

  it("uses the same standard escrow refund for an accepted funded grant", async () => {
    const f = fixture({ grant: true }); f.state.state = 1;
    const pending = await startEscrowAdminCancellation(f.options);
    assert.equal(pending.status, "pending");
    f.confirm(); await reconcileEscrowAdminCancellation({ ...f.options, id: f.id });
    assert.equal((await getEscrowAdminCancellation(f.options)).status, "complete");
  });

  it("verifies removed proposals through the server-preserved original posting owner", async () => {
    const f = fixture();
    f.db.records.set(`proposals/${f.proposalId}`, { ...f.record, postingOwnerId: "", moderationStatus: "removed",
      moderation: { originalPostingOwnerId: owner } });
    const pending = await startEscrowAdminCancellation(f.options);
    assert.equal(pending.status, "pending");
    assert.equal(f.db.records.get(`proposals/${f.proposalId}`).postingOwnerId, "", "removed member content remains redacted");
    f.confirm(); await reconcileEscrowAdminCancellation({ ...f.options, id: f.id });
    assert.equal((await getEscrowAdminCancellation(f.options)).status, "complete");
  });

  it("preserves the durable request on RPC failure and recovers a signed transaction after a crash", async () => {
    const f = fixture(); await startEscrowAdminCancellation(f.options);
    f.client.getChainId = async () => { throw new Error("RPC unavailable"); };
    const unavailable = await getEscrowAdminCancellation(f.options);
    assert.equal(unavailable.status, "pending"); assert.equal(unavailable.summary, null); assert.equal(unavailable.canCancel, false);
    f.client.getChainId = async () => 421614;
    const job = f.db.records.get(`${ADMIN_CANCELLATIONS}/${f.id}`);
    f.db.records.set(`${ADMIN_CANCELLATIONS}/${f.id}`, { ...job, transactionHash: null, status: "queued" });
    f.confirm();
    await resumePlatformTransaction(f.options);
    assert.equal(f.db.records.get(`${ADMIN_CANCELLATIONS}/${f.id}`).transactionHash, signedHash);
    assert.equal(f.db.records.get(`${ADMIN_CANCELLATIONS}/${f.id}`).status, "pending", "receipt alone does not finalize its reason audit");
    f.db.records.set(`${PLATFORM_OUTBOX}/${deploymentKey(f.config)}`, { status: "idle", lastActionKey: "other-proposal" });
    await reconcileEscrowAdminCancellation({ ...f.options, id: f.id });
    assert.equal((await getEscrowAdminCancellation(f.options)).status, "complete");
    assert.equal(f.signedTransactions.length, 1);
  });

  it("confirms the reason anchor before auditing and notifies each verified depositor exactly once", async () => {
    const f = fixture(); await startEscrowAdminCancellation(f.options); f.confirm();
    await reconcileEscrowAdminCancellation({ ...f.options, id: f.id });
    const result = await getEscrowAdminCancellation(f.options);
    assert.equal(result.status, "complete"); assert.equal(result.request.refundAmountBaseUnits, f.record.fundingTerms.target);
    const audit = f.db.records.get(`audits/escrow_admin_cancel_${f.id}`);
    assert.equal(audit.actor, admin); assert.equal(audit.chainActor, signer);
    assert.equal(audit.reason, f.reason); assert.equal(audit.verified, true); assert.equal(audit.transactionHash, signedHash);
    assert.equal(audit.reasonHash, adminCancellationReasonHash({ requestId: f.requestId, actorId: admin,
      proposalEntityId: f.expected.entityId, reason: f.reason }));
    assert.equal([...f.db.records.keys()].filter(key => key.startsWith("moderationNotifications/")).length, 1);
    f.db.records.set(`escrowFundingJobs/${f.id}`, { ...f.db.records.get(`escrowFundingJobs/${f.id}`), cursorBlock: 99 });
    for (const [name, actor, extra] of [["deposit-1", owner, {}], ["deposit-2", otherFunder, {}],
      ["deposit-3", otherFunder, {}], ["unverified", researcher, { verified: false }],
      ["wrong-deployment", researcher, { registryAddress: hash("1") }]]) {
      f.db.records.set(`escrowFundingEvents/${name}`, { proposalId: f.proposalId, eventType: "Deposit", verified: true,
        actor, chainId: f.config.chainId, registryAddress: f.config.address, escrowAddress, blockNumber: 90, ...extra });
    }
    await sweepEscrowAdminCancellations(f.options); await sweepEscrowAdminCancellations(f.options);
    const notices = [...f.db.records.entries()].filter(([key]) => key.startsWith("moderationNotifications/"));
    assert.equal(notices.length, 2); assert.deepEqual(new Set(notices.map(([, value]) => value.recipientId)), new Set([owner, otherFunder]));
    assert(notices.every(([, value]) => value.reason === f.reason && value.transactionHash === signedHash));
    assert.equal(f.db.records.get(`${ADMIN_CANCELLATIONS}/${f.id}`).notificationStatus, "complete");
  });

  it("leaves reorgs, mismatched reasons and unconfirmed receipts pending without claiming a successful cancellation", async () => {
    const f = fixture(); await startEscrowAdminCancellation(f.options);
    await reconcileEscrowAdminCancellation({ ...f.options, id: f.id });
    assert.equal(f.db.records.get(`${ADMIN_CANCELLATIONS}/${f.id}`).status, "pending");
    f.confirm({ canonical: false });
    await reconcileEscrowAdminCancellation({ ...f.options, id: f.id });
    assert.equal(f.db.records.get(`${ADMIN_CANCELLATIONS}/${f.id}`).status, "pending");
    f.confirm({ matchingReason: false });
    await assert.rejects(reconcileEscrowAdminCancellation({ ...f.options, id: f.id }), /matching administrator reason anchor/);
    assert.equal([...f.db.records.keys()].filter(key => key.startsWith("audits/")).length, 0);
  });

  it("blocks confirmed reverts and detects a payment before signing a queued cancellation", async () => {
    const f = fixture(); await startEscrowAdminCancellation(f.options); f.confirm({ success: false });
    await reconcileEscrowAdminCancellation({ ...f.options, id: f.id });
    assert.equal(f.db.records.get(`${ADMIN_CANCELLATIONS}/${f.id}`).status, "blocked");
    const g = fixture();
    g.client.sendRawTransaction = async () => { throw new Error("Network down after broadcast"); };
    const result = await startEscrowAdminCancellation(g.options);
    assert.equal(result.status, "pending"); assert.equal(g.signedTransactions.length, 1);
    const fresh = fixture();
    fresh.getWallet = fresh.options.getWallet = async () => {
      const wallet = await f.getWallet();
      return { ...wallet, prepareTransactionRequest: async request => { fresh.state.totalReleased = 1n; return request; } };
    };
    const queued = await startEscrowAdminCancellation(fresh.options);
    assert.equal(queued.status, "queued", "pre-sign rejection keeps durable request for verified reconciliation");
    assert.equal(fresh.signedTransactions.length, 0);
    await reconcileEscrowAdminCancellation({ ...fresh.options, id: fresh.id });
    assert.equal(fresh.db.records.get(`${ADMIN_CANCELLATIONS}/${fresh.id}`).status, "blocked");
  });

  it("respects maintenance and waits for deposit history before paged notification delivery", async () => {
    const f = fixture(); await startEscrowAdminCancellation(f.options); f.confirm();
    await reconcileEscrowAdminCancellation({ ...f.options, id: f.id });
    await sweepEscrowAdminCancellations(f.options);
    assert.equal(f.db.records.get(`${ADMIN_CANCELLATIONS}/${f.id}`).notificationStatus, "pending");
    f.db.records.set("maintenanceState/registryCutover", { active: true });
    assert.deepEqual(await sweepEscrowAdminCancellations(f.options), { maintenance: true });
    await assert.rejects(startEscrowAdminCancellation(f.options), /maintenance/);
  });
});
