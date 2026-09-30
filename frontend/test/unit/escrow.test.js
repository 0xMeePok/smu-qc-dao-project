import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, keccak256, stringToHex } from "viem";
import { confirmEscrowTransaction, ESCROW_STATE, escrowErrorMessage, hashEscrowEvidence, readEscrow, readPostingFundingStarted, writeEscrowAction } from "../../src/lib/escrow.js";
import { escrowAddress, escrowClient, escrowConfig, escrowRecord, owner, researcher, txHash } from "../../../firebase/functions/test/fixtures/escrowAuditFixture.js";
import { opportunityEntityId } from "../../../firebase/functions/auditCanonical.js";

const funder = `0x${"1".repeat(40)}`, platform = `0x${"2".repeat(40)}`;
const selectionId = `0x${"6".repeat(64)}`, zeroHash = `0x${"0".repeat(64)}`;
const evidence = { summary: "Completed benchmarks and delivered source code.", url: "https://example.com/delivery" };
const evidenceHash = hashEscrowEvidence(evidence);
const target = 1_200_250_000n;

function fixture(changes = {}) {
  const proposal = escrowRecord();
  if (changes.funderVoting !== undefined) proposal.fundingTerms.funderVoting = changes.funderVoting;
  const base = escrowClient(proposal);
  const reads = [], writes = [], waits = [];
  const state = {
    state: ESCROW_STATE.Open, platformSigner: platform, totalDeposited: 0n, totalReleased: 0n, totalRefunded: 0n,
    feePaid: 0n, feeBps: 10, selectionId, currentTranche: 0n, approvalDeadline: 1_900_086_400n,
    ownerApproved: false, solutionApproved: false, yesWeight: 0n, noWeight: 0n, refundsEnabled: false,
    refundAvailableAt: 0n, outstandingBalance: 0n, funderCount: 0n, ...changes.state,
  };
  const summary = { deposited: 0n, depositCount: 0n, refunded: 0n, claimable: 0n, released: 0n, status: 0, ...changes.depositor };
  const adapters = {
    getBlock: async () => ({ number: 100n, timestamp: changes.timestamp ?? 1_900_000_000n }),
    readContract: async request => {
      encodeFunctionData(request);
      reads.push(request);
      const { address, functionName, args } = request;
      if (changes.read) {
        const value = changes.read(request);
        if (value !== undefined) return value;
      }
      if (address === escrowConfig.address) {
        if (functionName === "isFundingActive") return changes.active ?? true;
        if (functionName === "isFundingInvalidated") return changes.invalidated ?? !(changes.active ?? true);
        if (functionName === "postingFundingPaused") return changes.paused ?? false;
        if (functionName === "postingFundingStarted") return changes.fundingStarted ?? false;
      }
      if (address === proposal.fundingTerms.token) {
        if (functionName === "decimals") return 6;
        if (functionName === "balanceOf") return changes.balance ?? target * 2n;
        if (functionName === "allowance") return changes.allowance ?? 0n;
      }
      if (address === escrowConfig.escrow.factoryAddress && functionName === "allowedTokens") return changes.tokenListed ?? true;
      if (address === escrowAddress) {
        if (functionName in state) return state[functionName];
        if (functionName === "depositorSummary") return summary;
        if (functionName === "hasVoted") return changes.hasVoted ?? false;
        if (functionName === "milestoneAt") return { ...await base.readContract(request),
          evidenceHash: Number(args[0]) === 1 ? changes.evidenceHash ?? evidenceHash : zeroHash, fee: 0n,
          paid: Number(args[0]) < Number(state.currentTranche) };
      }
      return base.readContract(request);
    },
    writeContract: async request => { encodeFunctionData(request); writes.push(request); return txHash; },
    waitForTransactionReceipt: async request => {
      waits.push(request);
      if (changes.wait) return changes.wait(request);
      return { status: "success", transactionHash: txHash, blockNumber: 101n };
    },
  };
  return { proposal, adapters, config: escrowConfig, reads, writes, waits };
}

function finalFixture(changes = {}) {
  return fixture({ ...changes, state: { state: ESCROW_STATE.Active, currentTranche: 1n,
    totalDeposited: target, totalReleased: target / 2n, outstandingBalance: target / 2n, ...changes.state } });
}

describe("Canonical escrow wallet integration", () => {
  it("does not offer permanent withdrawal refunds during a reversible funding pause", async () => {
    const f = fixture({ active: false, invalidated: false, paused: true });
    // This also validates the new getters before deployment manifests are regenerated.
    f.config = { ...f.config, abi: [...f.config.abi.filter(item => !["isFundingInvalidated", "postingFundingPaused"].includes(item.name)),
      { type: "function", name: "isFundingInvalidated", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
      { type: "function", name: "postingFundingPaused", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
    ] };
    const result = await readEscrow({ ...f, account: funder });
    assert.equal(result.workflowPaused, true);
    assert.equal(result.can.deposit, false);
    assert.equal(result.can.refundInvalidated, false);
  });
  it("reads all escrow state at one block and uses both mappings, never a supplied escrow address", async () => {
    const f = fixture();
    f.proposal.escrowAddress = `0x${"f".repeat(40)}`;
    const result = await readEscrow({ ...f, account: funder });
    assert.equal(result.address, escrowAddress);
    assert.equal(result.symbol, "USDC");
    assert.equal(result.decimals, 6);
    assert.equal(result.expiresAt, 2_000_000_000n);
    assert.equal(result.state, ESCROW_STATE.Open);
    assert.equal(result.currentTranche, 0);
    assert.equal(result.milestones[0].grossAmount, target / 2n);
    assert.equal(result.wallet.balance, target * 2n);
    assert.equal(result.can.deposit, true);
    assert.equal(result.can.lockSelection, false);
    assert.equal(result.can.release, false);
    assert(f.reads.every(request => request.blockNumber === 100n && request.chainId === 421614));
    assert(f.reads.some(request => request.functionName === "proposalEscrow"));
    assert(f.reads.some(request => request.functionName === "escrowForProposal"));
    assert.equal(f.writes.length, 0);
  });

  it("refuses unlinked mappings, changed terms and changed content", async () => {
    for (const read of [
      request => request.functionName === "escrowForProposal" ? `0x${"f".repeat(40)}` : undefined,
      request => request.functionName === "fundingTarget" ? 7n : undefined,
      request => request.functionName === "getProposal" ? { proposalHash: zeroHash, solutionHash: zeroHash } : undefined,
    ]) {
      const f = fixture({ read });
      await assert.rejects(writeEscrowAction({ ...f, account: funder, action: "deposit", amount: "1" }), /Mismatch/);
      assert.equal(f.writes.length, 0);
    }
  });

  it("blocks new deposits for changed token precision or delisting while retaining refunds", async () => {
    for (const changes of [{ tokenListed: false }, { read: request => request.functionName === "decimals" ? 18 : undefined }]) {
      const f = fixture({ ...changes, depositor: { deposited: 10n, claimable: 10n } });
      const snapshot = await readEscrow({ ...f, account: funder });
      assert.equal(snapshot.can.deposit, false);
      assert.equal(snapshot.can.claimRefund, true);
      await assert.rejects(writeEscrowAction({ ...f, account: funder, action: "deposit", amount: "1" }), /not available/);
      assert.equal(f.writes.length, 0);
    }
  });

  it("requires a strict weighted majority even when all cast votes are yes", async () => {
    const f = finalFixture({ state: { yesWeight: target / 2n, ownerApproved: true, solutionApproved: true } });
    const tied = await readEscrow({ ...f, account: platform });
    assert.equal(tied.can.releaseMilestone, false);
    assert.equal(tied.noWeight, 0n);
    const passed = await readEscrow({ ...finalFixture({ state: { yesWeight: target / 2n + 1n, ownerApproved: true, solutionApproved: true } }), account: platform });
    assert.equal(passed.can.releaseMilestone, true);
    const missingOwner = await readEscrow({ ...finalFixture({ state: { yesWeight: target } }), account: platform });
    assert.equal(missingOwner.can.releaseMilestone, false);
  });

  it("keeps the owner-only variant free of funder votes and requires unexpired evidence review", async () => {
    const f = finalFixture({ funderVoting: false, state: { ownerApproved: true, solutionApproved: true } });
    await writeEscrowAction({ ...f, account: platform, action: "releaseMilestone", evidenceHash });
    assert.deepEqual(f.writes[0].args, [selectionId, 1n, evidenceHash]);
    for (const changes of [{ evidenceHash: zeroHash }, { timestamp: 1_900_086_400n }, { state: { ownerApproved: true } }]) {
      const unavailable = await readEscrow({ ...finalFixture(changes), account: owner });
      assert.equal(unavailable.can.approveMilestone, false);
    }
    const voted = await readEscrow({ ...finalFixture({ depositor: { deposited: 10n }, hasVoted: true }), account: funder });
    assert.equal(voted.can.voteMilestone, false);
  });

  it("requests exactly the deposit allowance, then confirms before depositing", async () => {
    const f = fixture();
    const progress = [];
    const result = await writeEscrowAction({ ...f, account: funder, action: "deposit", amount: "1.25", onProgress: update => progress.push(update) });
    assert.deepEqual(f.writes.map(write => [write.functionName, write.args]), [["approve", [escrowAddress, 1_250_000n]], ["deposit", [1_250_000n]]]);
    assert.equal(f.writes[0].address, f.proposal.fundingTerms.token);
    assert.equal(f.writes[1].address, escrowAddress);
    assert(f.writes.every(write => write.account === funder && write.chainId === 421614));
    assert.deepEqual(progress.map(update => `${update.action}:${update.status}`), ["approve:awaiting_signature", "approve:pending", "approve:confirmed", "deposit:awaiting_signature", "deposit:pending", "deposit:confirmed"]);
    assert.equal(result.transactionHash, txHash);
  });

  it("clears an insufficient nonzero allowance and reuses sufficient allowance", async () => {
    const f = fixture({ allowance: 1n });
    await writeEscrowAction({ ...f, account: funder, action: "deposit", amount: "2" });
    assert.deepEqual(f.writes.map(write => [write.functionName, write.args]), [["approve", [escrowAddress, 0n]], ["approve", [escrowAddress, 2_000_000n]], ["deposit", [2_000_000n]]]);
    const sufficient = fixture({ allowance: 2_000_000n });
    await writeEscrowAction({ ...sufficient, account: funder, action: "deposit", amount: "2" });
    assert.deepEqual(sufficient.writes.map(write => write.functionName), ["deposit"]);
  });

  it("rejects excessive, imprecise and unaffordable deposits before wallet approval", async () => {
    for (const amount of ["1200.250001", "0.0000001", "0", "-1", "1e2"]) {
      const f = fixture();
      await assert.rejects(writeEscrowAction({ ...f, account: funder, action: "deposit", amount }));
      assert.equal(f.writes.length, 0);
    }
    const f = fixture({ balance: 1n });
    await assert.rejects(writeEscrowAction({ ...f, account: funder, action: "deposit", amount: "1" }), /balance is too low/);
    assert.equal(f.writes.length, 0);
  });

  it("halts on an uncertain approval receipt and confirms the same hash without resending", async () => {
    let unavailable = true;
    const f = fixture({ wait: async () => {
      if (unavailable) throw new Error("Receipt fetch unavailable");
      return { status: "success", transactionHash: txHash };
    } });
    await assert.rejects(writeEscrowAction({ ...f, account: funder, action: "deposit", amount: "1" }), error => {
      assert.equal(error.transactionHash, txHash);
      assert.equal(error.transactionSettled, undefined);
      return /unavailable/.test(error.message);
    });
    assert.equal(f.writes.length, 1);
    assert.equal(f.waits.length, 1);
    unavailable = false;
    const confirmed = await confirmEscrowTransaction(txHash, f);
    assert.equal(confirmed.receipt.status, "success");
    assert.equal(f.writes.length, 1);
  });

  for (const outcome of ["cancelled", "replaced", "reverted"]) it(`does not deposit after a ${outcome} token approval`, async () => {
    const f = fixture({ wait: async request => {
      if (outcome !== "reverted") request.onReplaced({ reason: outcome });
      return { status: outcome === "reverted" ? "reverted" : "success", transactionHash: txHash };
    } });
    await assert.rejects(writeEscrowAction({ ...f, account: funder, action: "deposit", amount: "1" }), error => {
      assert.equal(error.transactionHash, txHash);
      assert.equal(error.transactionSettled, true);
      return true;
    });
    assert.equal(f.writes.length, 1);
  });

  it("submits the persisted evidence digest only from the proposal owner", async () => {
    const f = finalFixture({ evidenceHash: zeroHash });
    const result = await writeEscrowAction({ ...f, account: researcher, action: "submitMilestone", evidence, evidenceHash });
    assert.equal(result.evidenceHash, evidenceHash);
    assert.deepEqual(f.writes[0].args, [1n, evidenceHash]);
    for (const input of [{ account: owner, evidenceHash }, { account: researcher, evidenceHash: zeroHash }]) {
      const invalid = finalFixture();
      await assert.rejects(writeEscrowAction({ ...invalid, ...input, action: "submitMilestone", evidence }));
      assert.equal(invalid.writes.length, 0);
    }
    const alreadySubmitted = finalFixture();
    await assert.rejects(writeEscrowAction({ ...alreadySubmitted, account: researcher, action: "submitMilestone", evidence }), /already submitted/);
    assert.equal(alreadySubmitted.writes.length, 0);
  });

  it("requires the evidence actually reviewed for completion approval and votes", async () => {
    const f = finalFixture();
    await writeEscrowAction({ ...f, account: owner, action: "approveMilestone", evidenceHash });
    assert.deepEqual(f.writes[0].args, [selectionId, 1n, evidenceHash]);
    const voter = finalFixture({ depositor: { deposited: 700_000_000n } });
    await writeEscrowAction({ ...voter, account: funder, action: "voteMilestone", evidenceHash, approve: true });
    assert.deepEqual(voter.writes[0].args, [1n, evidenceHash, true]);
    for (const hash of [undefined, zeroHash]) {
      const invalid = finalFixture();
      await assert.rejects(writeEscrowAction({ ...invalid, account: owner, action: "approveMilestone", evidenceHash: hash }));
      assert.equal(invalid.writes.length, 0);
    }
  });

  it("requires platform signatures for selection locking and release, and fresh owner approvals", async () => {
    const f = fixture({ state: { totalDeposited: target } });
    await writeEscrowAction({ ...f, account: platform, action: "lockSelection", selectionId });
    assert.deepEqual(f.writes[0].args, [selectionId, researcher]);
    const locked = fixture({ state: { state: ESCROW_STATE.Locked, totalDeposited: target } });
    await writeEscrowAction({ ...locked, account: researcher, action: "approveSelection", selectionId });
    assert.deepEqual(locked.writes[0].args, [selectionId]);
    await assert.rejects(writeEscrowAction({ ...locked, account: platform, action: "release" }), /not available/);
    const approved = fixture({ state: { state: ESCROW_STATE.Locked, totalDeposited: target, ownerApproved: true, solutionApproved: true } });
    await writeEscrowAction({ ...approved, account: platform, action: "release" });
    assert.deepEqual(approved.writes[0].args, [selectionId]);
    await assert.rejects(writeEscrowAction({ ...approved, account: owner, action: "release" }), /not available/);
  });

  it("keeps refund and expiration exits available after registry withdrawal", async () => {
    const f = finalFixture({ active: false, timestamp: 1_900_086_400n, depositor: { deposited: 10n, claimable: 5n } });
    const snapshot = await readEscrow({ ...f, account: funder });
    assert.equal(snapshot.can.deposit, false);
    assert.equal(snapshot.can.voteMilestone, false);
    assert.equal(snapshot.can.claimRefund, true);
    assert.equal(snapshot.can.expire, true);
    assert.equal(snapshot.can.refundInvalidated, true);
    for (const action of ["claimRefund", "expire", "refundInvalidated"]) {
      await writeEscrowAction({ ...f, account: funder, action });
    }
    assert.deepEqual(f.writes.map(write => [write.functionName, write.args]), [["claimRefund", []], ["expire", []], ["refundInvalidated", []]]);
  });

  it("matches the contract's distinct upfront and final refund deadlines", async () => {
    const locked = fixture({ state: { state: ESCROW_STATE.Locked, totalDeposited: target,
      approvalDeadline: 1_900_000_000n, ownerApproved: true, solutionApproved: true }, depositor: { deposited: 10n } });
    const lapsedUpfront = await readEscrow({ ...locked, account: platform });
    assert.equal(lapsedUpfront.can.release, false);
    assert.equal(lapsedUpfront.can.expire, false); // Upfront refunds still wait for the posting expiry.
    const expiredPosting = await readEscrow({ ...fixture({ timestamp: 2_000_000_000n,
      state: { state: ESCROW_STATE.Locked, approvalDeadline: 1_900_000_000n } }), account: platform });
    assert.equal(expiredPosting.can.expire, true);
    const finalDeadline = await readEscrow({ ...finalFixture({ timestamp: 1_900_086_400n }), account: researcher });
    assert.equal(finalDeadline.can.expire, true);
    assert.equal(finalDeadline.can.submitMilestone, false);
    assert.equal(finalDeadline.can.approveMilestone, false);
  });

  it("reads the parent funding lock using its owner-scoped canonical id", async () => {
    const f = fixture({ fundingStarted: true });
    const posting = { id: "posting-1", ownerId: owner, amount: 100, expiresAt: new Date("2030-01-01T00:00:00Z") };
    assert.equal(await readPostingFundingStarted(posting, f), true);
    const call = f.reads.find(read => read.functionName === "postingFundingStarted");
    assert.equal(call.address, escrowConfig.address);
    assert.deepEqual(call.args, [opportunityEntityId(posting.id, { actor: owner })]);
    assert.equal(f.writes.length, 0);
  });
});

describe("Escrow evidence and error messages", () => {
  it("hashes the exact normalized delivery schema and rejects invalid evidence", () => {
    assert.equal(hashEscrowEvidence(evidence), keccak256(stringToHex(JSON.stringify({ scheme: "qcdao.escrow.delivery.v1", ...evidence }))));
    assert.equal(hashEscrowEvidence({ summary: " Cafe\u0301 ", url: " https://example.com/proof " }), hashEscrowEvidence({ summary: "Caf\u00e9", url: "https://example.com/proof" }));
    for (const invalid of [{ summary: "x", url: evidence.url }, { summary: "x".repeat(4001), url: evidence.url },
      { ...evidence, url: "http://example.com" }, { ...evidence, url: "https:example.com" }, { ...evidence, url: "HTTPS://example.com" }, { ...evidence, url: "" }]) {
      assert.throws(() => hashEscrowEvidence(invalid));
    }
  });
  it("explains nested contract errors and wallet rejection", () => {
    assert.match(escrowErrorMessage({ cause: { data: { errorName: "FunderMajorityRequired" } } }), /more than half/);
    assert.match(escrowErrorMessage({ cause: { code: 4001 } }), /declined/);
  });
});
