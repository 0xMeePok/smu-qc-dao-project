import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, keccak256, stringToHex } from "viem";
import { confirmEscrowTransaction, ESCROW_STATE, escrowErrorMessage, hashEscrowEvidence, hashEscrowSelectionRejection, readEscrow, readPostingFundingStarted, writeEscrowAction } from "../../src/lib/escrow.js";
import { escrowAddress, escrowClient, escrowConfig, escrowRecord, owner, researcher, txHash } from "../../../firebase/functions/test/fixtures/escrowAuditFixture.js";
import { AUDIT_REGISTRY_CONFIG } from "../../src/config/auditRegistry.js";
import historicalRegistries from "../../../firebase/functions/auditRegistry.history.json" with { type: "json" };
import { proposalFundingTerms } from "../../../firebase/functions/escrowProposalTerms.js";
import { opportunityEntityId } from "../../../firebase/functions/auditCanonical.js";

const funder = `0x${"1".repeat(40)}`, platform = `0x${"2".repeat(40)}`;
const selectionId = `0x${"6".repeat(64)}`, zeroHash = `0x${"0".repeat(64)}`;
const evidence = { summary: "Completed benchmarks and delivered source code.", url: "https://example.com/delivery" };
const evidenceHash = hashEscrowEvidence(evidence);
const target = 1_200_250_000n;

function fixture(changes = {}) {
  const proposal = escrowRecord();
  if (changes.funderVoting !== undefined) proposal.fundingTerms.funderVoting = changes.funderVoting;
  if (changes.opportunityType !== undefined) proposal.opportunityType = changes.opportunityType;
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
        if (functionName === "pendingProposalForPosting") return changes.pendingProposalId ?? zeroHash;
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
    writeContract: async (request, options) => { encodeFunctionData(request); options?.onWalletRequest?.(); writes.push(request); return txHash; },
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

function rejectionFixture(changes = {}) {
  const f = fixture({ ...changes, state: { state: ESCROW_STATE.Locked, totalDeposited: target, ...changes.state } });
  f.config = { ...f.config, abi: [...f.config.abi,
    { type: "function", name: "pendingProposalForPosting", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] }],
    escrow: { ...f.config.escrow, escrowAbi: [...f.config.escrow.escrowAbi,
      { type: "function", name: "rejectSelection", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "bytes32" }], outputs: [] }] } };
  return f;
}

function legacySelectionFixture(changes = {}) {
  const f = fixture(changes);
  f.config = { ...f.config, abi: f.config.abi.filter(item => item.name !== "pendingProposalForPosting"),
    escrow: { ...f.config.escrow, escrowAbi: f.config.escrow.escrowAbi.filter(item => item.name !== "rejectSelection") } };
  return f;
}

describe("Canonical escrow wallet integration", () => {
  it("approves upfront for either owner with fewer reads and no unrelated wallet/reporting requests", async t => {
    const omitted = ["balanceOf", "allowance", "depositorSummary", "hasVoted", "totalRefunded", "refundAvailableAt", "yesWeight", "noWeight", "allowedTokens", "decimals"];
    for (const account of [owner, researcher]) {
      const full = fixture({ state: { state: ESCROW_STATE.Locked } });
      const fullSnapshot = await readEscrow({ ...full, account });
      assert.equal(fullSnapshot.can.approveSelection, true);
      const f = fixture({ state: { state: ESCROW_STATE.Locked }, read: request => {
        if (omitted.includes(request.functionName)) throw new Error(`Unrelated read: ${request.functionName}`);
      } });
      await writeEscrowAction({ ...f, account, action: "approveSelection", selectionId });
      assert.deepEqual(f.writes.map(request => [request.functionName, request.args]), [["approveSelection", [selectionId]]]);
      t.diagnostic(`${f.reads.length} approval reads versus ${full.reads.length} dashboard reads`);
      assert(f.reads.length < full.reads.length, `${f.reads.length} approval reads versus ${full.reads.length} dashboard reads`);
      assert(f.reads.every(request => request.blockNumber === 100n && request.chainId === 421614));
      assert.equal(f.reads.filter(request => request.functionName === "problemOwner").length, 1);
      assert.equal(f.reads.filter(request => request.functionName === "proposalOwner").length, 1);
    }
  });

  it("does not open the approval wallet before canonical, content and eligibility checks settle", async () => {
    for (const blockedName of ["milestoneAt", "getProposal", "isFundingActive"]) {
      let releaseRead;
      const gate = new Promise(resolve => { releaseRead = resolve; });
      const base = escrowClient(escrowRecord());
      const f = fixture({ state: { state: ESCROW_STATE.Locked }, read: request => request.functionName === blockedName
        ? gate.then(() => blockedName === "isFundingActive" ? true : base.readContract(request)) : undefined });
      const action = writeEscrowAction({ ...f, account: owner, action: "approveSelection", selectionId });
      await new Promise(resolve => setImmediate(resolve));
      assert(f.reads.some(request => request.functionName === blockedName));
      // Content verification starts alongside canonical reads, even if a milestone is slow.
      assert(f.reads.some(request => request.functionName === "getProposal"));
      assert.equal(f.writes.length, 0);
      releaseRead();
      await action;
      assert.equal(f.writes.length, 1);
    }
  });

  it("preserves upfront approval eligibility for both owners and blocks stale selections", async () => {
    for (const changes of [
      { account: owner, state: { ownerApproved: true } },
      { account: researcher, state: { solutionApproved: true } },
      { account: funder }, { active: false },
      { timestamp: 1_900_086_400n }, { state: { state: ESCROW_STATE.Open } },
      { state: { state: ESCROW_STATE.Active } }, { state: { currentTranche: 1n } },
      { selected: zeroHash },
    ]) {
      const f = fixture({ ...changes, state: { state: ESCROW_STATE.Locked, ...changes.state } });
      await assert.rejects(writeEscrowAction({ ...f, account: changes.account ?? owner, action: "approveSelection",
        selectionId: changes.selected ?? selectionId }), /not available|selected proposal changed/);
      assert.equal(f.writes.length, 0);
    }
  });

  it("still blocks upfront approval for canonical/content mismatches or failed required reads", async () => {
    for (const read of [
      request => request.functionName === "escrowForProposal" ? funder : undefined,
      request => request.functionName === "fundingTarget" ? 7n : undefined,
      request => request.functionName === "proposalOwner" ? funder : undefined,
      request => request.functionName === "getProposal" ? { proposalHash: zeroHash, solutionHash: zeroHash } : undefined,
      request => request.functionName === "milestoneAt" ? { bps: 1n, reviewWindow: 1n, descriptionHash: zeroHash, grossAmount: 1n } : undefined,
      request => request.functionName === "ownerApproved" ? Promise.reject(new Error("Approval RPC unavailable")) : undefined,
    ]) {
      const f = fixture({ state: { state: ESCROW_STATE.Locked }, read });
      await assert.rejects(writeEscrowAction({ ...f, account: owner, action: "approveSelection", selectionId }), /Mismatch|Approval RPC unavailable/);
      assert.equal(f.writes.length, 0);
    }
  });

  it("uses only verified action data for deposits, evidence submission, completion approvals and votes", async t => {
    for (const { action, account, changes, input } of [
      { action: "deposit", account: funder, changes: { allowance: target }, input: { amount: "1" } },
      { action: "submitMilestone", account: researcher, changes: { evidenceHash: zeroHash }, input: { evidence, evidenceHash } },
      { action: "approveMilestone", account: owner, changes: {}, input: { evidenceHash, selectionId } },
      { action: "approveMilestone", account: researcher, changes: {}, input: { evidenceHash, selectionId } },
      { action: "voteMilestone", account: funder, changes: { depositor: { deposited: 10n } }, input: { evidenceHash, selectionId, approve: true } },
    ]) {
      const make = action === "deposit" ? fixture : finalFixture;
      const full = make(changes);
      assert.equal((await readEscrow({ ...full, account })).can[action], true);
      const omitted = ["feeBps", "feePaid", "totalReleased", "totalRefunded", "refundAvailableAt", "refundsEnabled", "yesWeight", "noWeight", "outstandingBalance", "funderCount", "platformSigner", "postingFundingPaused", "isFundingInvalidated"];
      if (action !== "deposit") omitted.push("balanceOf", "allowance", "decimals", "allowedTokens");
      if (action !== "voteMilestone") omitted.push("depositorSummary", "hasVoted");
      const f = make({ ...changes, read: request => {
        if (omitted.includes(request.functionName)) throw new Error(`Unrelated read: ${request.functionName}`);
      } });
      await writeEscrowAction({ ...f, account, action, ...input });
      assert.equal(f.writes.at(-1).functionName, action);
      assert(f.reads.every(request => request.blockNumber === 100n && request.chainId === 421614));
      assert(f.reads.length < full.reads.length);
      t.diagnostic(`${action}: ${f.reads.length} action reads versus ${full.reads.length} dashboard reads`);
    }
  });

  it("preserves every deposit eligibility guard without requiring depositor history", async () => {
    for (const changes of [
      { active: false }, { tokenListed: false }, { balance: 0n }, { timestamp: 2_000_000_000n },
      { state: { state: ESCROW_STATE.Locked } }, { state: { totalDeposited: target } },
      { opportunityType: "open-funding", funderVoting: false },
      { read: request => request.functionName === "decimals" ? 18 : undefined },
    ]) {
      const f = fixture(changes);
      assert.equal((await readEscrow({ ...f, account: funder })).can.deposit, false);
      await assert.rejects(writeEscrowAction({ ...f, account: funder, action: "deposit", amount: "1" }), /not available/);
      assert.equal(f.writes.length, 0);
    }
  });

  it("keeps final review eligibility aligned with the dashboard for every wallet action", async () => {
    for (const action of ["submitMilestone", "approveMilestone", "voteMilestone"]) {
      const account = action === "submitMilestone" ? researcher : action === "approveMilestone" ? owner : funder;
      for (const changes of [
        { active: false }, { timestamp: 1_900_086_400n }, { state: { state: ESCROW_STATE.Locked } },
        { state: { currentTranche: 0n } }, { state: { ownerApproved: true } },
        { funderVoting: false }, { hasVoted: true }, { depositor: { deposited: 0n } },
      ]) {
        const options = { depositor: { deposited: 10n }, evidenceHash: action === "submitMilestone" ? zeroHash : evidenceHash, ...changes };
        const expected = (await readEscrow({ ...finalFixture(options), account })).can[action];
        const f = finalFixture(options);
        const promise = writeEscrowAction({ ...f, account, action, evidence, evidenceHash, selectionId, approve: true });
        if (expected) { await promise; assert.equal(f.writes.length, 1); }
        else { await assert.rejects(promise, /not available/); assert.equal(f.writes.length, 0); }
      }
    }
  });

  it("waits for required deposit and final-review reads before requesting signatures", async () => {
    for (const [action, blockedName, value] of [
      ["deposit", "allowance", target], ["deposit", "allowedTokens", true],
      ["approveMilestone", "ownerApproved", false], ["voteMilestone", "hasVoted", false],
    ]) {
      let releaseRead;
      const gate = new Promise(resolve => { releaseRead = resolve; });
      const f = (action === "deposit" ? fixture : finalFixture)({ depositor: { deposited: 10n }, read: request =>
        request.functionName === blockedName ? gate : undefined });
      const account = action === "approveMilestone" ? owner : funder;
      const promise = writeEscrowAction({ ...f, action, account, amount: "1", evidenceHash, selectionId, approve: true });
      await new Promise(resolve => setImmediate(resolve));
      assert(f.reads.some(request => request.functionName === blockedName));
      assert.equal(f.writes.length, 0);
      releaseRead(value);
      await promise;
      assert.equal(f.writes.at(-1).functionName, action);
    }
  });

  it("blocks final actions on failed canonical checks, changed evidence, stale selection and failed vote reads", async () => {
    for (const action of ["submitMilestone", "approveMilestone", "voteMilestone"]) {
      for (const read of [
        request => request.functionName === "escrowForProposal" ? funder : undefined,
        request => request.functionName === "getProposal" ? { proposalHash: zeroHash, solutionHash: zeroHash } : undefined,
        request => request.functionName === "milestoneAt" ? { bps: 1n, reviewWindow: 1n, descriptionHash: zeroHash, grossAmount: 1n } : undefined,
      ]) {
        const f = finalFixture({ read, depositor: { deposited: 10n } });
        await assert.rejects(writeEscrowAction({ ...f, action, account: action === "submitMilestone" ? researcher : action === "voteMilestone" ? funder : owner,
          evidence, evidenceHash, selectionId, approve: true }), /Mismatch/);
        assert.equal(f.writes.length, 0);
      }
    }
    for (const action of ["approveMilestone", "voteMilestone"]) {
      for (const input of [{ evidenceHash: zeroHash }, { selectionId: zeroHash }]) {
        const f = finalFixture({ depositor: { deposited: 10n } });
        await assert.rejects(writeEscrowAction({ ...f, action, account: action === "voteMilestone" ? funder : owner,
          evidenceHash, selectionId, approve: true, ...input }), /changed/);
        assert.equal(f.writes.length, 0);
      }
    }
    const f = finalFixture({ depositor: { deposited: 10n }, read: request => request.functionName === "hasVoted"
      ? Promise.reject(new Error("Vote RPC unavailable")) : undefined });
    await assert.rejects(writeEscrowAction({ ...f, account: funder, action: "voteMilestone", evidenceHash, approve: true }), /Vote RPC unavailable/);
    assert.equal(f.writes.length, 0);
  });

  it("resolves the audit deployment once before full-snapshot writes and retains historical write restrictions", async () => {
    const historical = { ...AUDIT_REGISTRY_CONFIG, address: `0x${"9".repeat(40)}` };
    historicalRegistries.push(historical);
    try {
      for (const [action, config, blocked] of [
        ["release", AUDIT_REGISTRY_CONFIG, false], ["claimRefund", AUDIT_REGISTRY_CONFIG, false],
        ["deposit", AUDIT_REGISTRY_CONFIG, false], ["approveMilestone", AUDIT_REGISTRY_CONFIG, false],
        ["deposit", historical, true], ["approveMilestone", historical, true],
        ["claimRefund", historical, false],
      ]) {
        let resolutions = 0, blocks = 0;
        const proposal = { ...escrowRecord(), currency: config.escrow.tokens[0].symbol,
          audit: { transactionHash: txHash, chainId: config.chainId } };
        proposal.fundingTerms = proposalFundingTerms({ form: proposal, currency: proposal.currency, config });
        // Stop at the block read: deployment resolution must already be single-shot,
        // with historical financial writes rejected before constructing a snapshot.
        const adapters = {
          getTransaction: async () => { resolutions++; return { hash: txHash, to: config.address, chainId: config.chainId }; },
          getBlock: async () => { blocks++; throw new Error("Reached verified snapshot"); },
        };
        await assert.rejects(writeEscrowAction({ proposal, account: owner, action, adapters }),
          blocked ? /earlier AuditRegistry/ : /Reached verified snapshot/);
        assert.equal(resolutions, 1);
        assert.equal(blocks, blocked ? 0 : 1);
      }
    } finally {
      historicalRegistries.pop();
    }
  });

  it("overlaps wallet reads with live state but waits for all verification before opening the wallet", async () => {
    let releaseState;
    const stateGate = new Promise(resolve => { releaseState = resolve; });
    const f = fixture({ allowance: target, read: request => request.functionName === "state" ? stateGate : undefined });
    const action = writeEscrowAction({ ...f, account: funder, action: "deposit", amount: "1" });
    await new Promise(resolve => setImmediate(resolve));
    for (const functionName of ["balanceOf", "allowance"]) {
      assert(f.reads.some(request => request.functionName === functionName), `${functionName} starts before state resolves`);
    }
    assert(f.reads.every(request => request.blockNumber === 100n));
    assert.equal(f.writes.length, 0);
    releaseState(ESCROW_STATE.Open);
    await action;
    assert.deepEqual(f.writes.map(request => request.functionName), ["deposit"]);
  });

  it("does not open the wallet when a concurrent wallet-state read fails", async () => {
    const f = fixture({ read: request => request.functionName === "balanceOf"
      ? Promise.reject(new Error("Wallet state RPC unavailable")) : undefined });
    await assert.rejects(writeEscrowAction({ ...f, account: funder, action: "deposit", amount: "1" }), /Wallet state RPC unavailable/);
    assert.equal(f.writes.length, 0);
  });

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
    assert.equal(f.waits.length, 2);
    assert(f.waits.every(request => request.confirmations === 2));
    assert.deepEqual(progress.map(update => `${update.action}:${update.status}`), ["deposit:preparing", "approve:preparing", "approve:awaiting_signature", "approve:pending", "approve:confirmed", "deposit:preparing", "deposit:awaiting_signature", "deposit:pending", "deposit:confirmed"]);
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
    assert.equal(f.waits.length, 2);
    assert.ok(f.waits.every(request => request.confirmations === 2));
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

  it("lets either main-workflow owner reject only the current pending selection with a reason hash", async () => {
    const reason = "The delivery scope no longer fits our requirements.";
    for (const account of [owner, researcher]) {
      const f = rejectionFixture();
      await writeEscrowAction({ ...f, account, action: "rejectSelection", selectionId, reason });
      assert.deepEqual(f.writes[0].args, [selectionId, hashEscrowSelectionRejection(reason)]);
    }
    for (const account of [funder, platform]) {
      const f = rejectionFixture();
      await assert.rejects(writeEscrowAction({ ...f, account, action: "rejectSelection", reason }), /not available/);
      assert.equal(f.writes.length, 0);
    }
    const stale = rejectionFixture();
    await assert.rejects(writeEscrowAction({ ...stale, account: owner, action: "rejectSelection", reason, selectionId: zeroHash }), /proposal changed/);
    assert.equal(stale.writes.length, 0);
    const invalid = rejectionFixture();
    await assert.rejects(writeEscrowAction({ ...invalid, account: owner, action: "rejectSelection", reason: "too short" }), /10–2,000/);
    assert.equal(invalid.writes.length, 0);
  });

  it("opens main selection expiry refunds exactly at its approval deadline", async () => {
    const before = await readEscrow({ ...rejectionFixture({ timestamp: 1_900_086_399n }), account: owner });
    assert.equal(before.can.approveSelection, true);
    assert.equal(before.can.rejectSelection, true);
    assert.equal(before.can.expire, false);
    const deadline = rejectionFixture({ timestamp: 1_900_086_400n });
    const expired = await readEscrow({ ...deadline, account: owner });
    assert.equal(expired.can.approveSelection, false);
    assert.equal(expired.can.rejectSelection, false);
    assert.equal(expired.can.expire, true);
    await writeEscrowAction({ ...deadline, account: funder, action: "expire" });
    assert.deepEqual(deadline.writes[0].args, []);
  });

  it("keeps selection rejection unavailable on old deployments, grants and delivery milestones", async () => {
    const old = await readEscrow({ ...legacySelectionFixture({ state: { state: ESCROW_STATE.Locked } }), account: owner });
    assert.equal(old.supportsSelectionRejection, false);
    assert.equal(old.can.rejectSelection, false);
    const grant = await readEscrow({ ...rejectionFixture({ opportunityType: "open-funding", funderVoting: false }), account: owner });
    assert.equal(grant.can.rejectSelection, false);
    const active = await readEscrow({ ...rejectionFixture({ state: { state: ESCROW_STATE.Active, currentTranche: 1n } }), account: researcher });
    assert.equal(active.can.rejectSelection, false);
  });

  it("shows the canonical pending sibling lock without enabling funding or permanent refunds", async () => {
    const f = rejectionFixture({ active: false, invalidated: false, pendingProposalId: `0x${"7".repeat(64)}`,
      state: { state: ESCROW_STATE.Open, totalDeposited: 0n } });
    const snapshot = await readEscrow({ ...f, account: funder });
    assert.equal(snapshot.blockedBySelection, true);
    assert.equal(snapshot.can.deposit, false);
    assert.equal(snapshot.can.lockSelection, false);
    assert.equal(snapshot.can.refundInvalidated, false);
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

  it("preserves earlier deployments' distinct upfront and final refund deadlines", async () => {
    const locked = legacySelectionFixture({ state: { state: ESCROW_STATE.Locked, totalDeposited: target,
      approvalDeadline: 1_900_000_000n, ownerApproved: true, solutionApproved: true }, depositor: { deposited: 10n } });
    const lapsedUpfront = await readEscrow({ ...locked, account: platform });
    assert.equal(lapsedUpfront.can.release, false);
    assert.equal(lapsedUpfront.can.expire, false); // Upfront refunds still wait for the posting expiry.
    const expiredPosting = await readEscrow({ ...legacySelectionFixture({ timestamp: 2_000_000_000n,
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
  it("hashes normalized rejection reasons and validates their bounds", () => {
    assert.equal(hashEscrowSelectionRejection("  Cafe\u0301 research scope changed.  "), hashEscrowSelectionRejection("Café research scope changed."));
    for (const reason of [undefined, "too short", "x".repeat(2001)]) assert.throws(() => hashEscrowSelectionRejection(reason), /10–2,000/);
  });
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

it("rejects fractional cents, small partial contributions and dusty remainders before any approval", async () => {
  for (const amount of ["1.000001", "0.99", "1199.26"]) {
    const f = fixture();
    await assert.rejects(writeEscrowAction({ ...f, account: funder, action: "deposit", amount }), /decimal places|at least 1|would leave/);
    assert.equal(f.writes.length, 0);
  }
  for (const remaining of [250000n, 1n]) {
    const f = fixture({ state: { totalDeposited: target - remaining } });
    await writeEscrowAction({ ...f, account: funder, action: "deposit", amount: remaining === 1n ? "0.000001" : "0.25" });
    assert.equal(f.writes.at(-1).functionName, "deposit");
    assert.deepEqual(f.writes.at(-1).args, [remaining]);
  }
});
it("explains decoded contract precision, minimum and dust errors", () => {
  for (const [name, message] of [["AmountPrecisionExceeded", /2 decimal places/], ["ContributionBelowMinimum", /at least 1/], ["ContributionLeavesDust", /leave less than 1/]]) {
    assert.match(escrowErrorMessage({ cause: { data: { errorName: name } } }), message);
  }
});
