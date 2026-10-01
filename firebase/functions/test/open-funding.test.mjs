import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getOpenFundingSummary, prepareOpenFundingAction, syncOpenFunding, supportsOpenFunding } from "../openFunding.js";
import { prepareEscrowDeposit, startEscrowSettlement, fundingBlockReason, settlementAction } from "../escrowFunding.js";
import { getFunderDashboard } from "../funderDashboard.js";
import { readVerifiedFunding } from "../escrowFunding.js";
import { Timestamp } from "firebase-admin/firestore";
import { fundMockProposal, selectMockProposal, confirmMockProposal } from "../matching.js";
import { openFundingFixture, owner, researcher, otherResearcher, poolAddress, zeroAddress } from "./fixtures/openFundingFixture.js";

describe("single-owner prefunded open funding", () => {
  it("fails closed on the active deployment without the grant ABIs", async () => {
    const f = openFundingFixture(); delete f.config.escrow.openFundingPoolAbi;
    assert.equal(supportsOpenFunding(f.config), false);
    assert.equal((await getOpenFundingSummary(f)).supported, false);
    await assert.rejects(prepareOpenFundingAction({ ...f, action: "deposit", amountBaseUnits: "1" }), /updated smart contracts/);
    assert.equal(f.simulations.length, 0);
  });
  it("keeps historical open funding out of legacy pooled mock deposits, selection and confirmation", async () => {
    const f = openFundingFixture(), row = { ...f.proposals[0] }; delete row.fundingTerms;
    f.db.records.set(`proposals/${row.id}`, row);
    const options = { ...f, proposalId: row.id, now: Timestamp.fromMillis(Number(f.state.timestamp) * 1000) };
    await assert.rejects(fundMockProposal({ ...options, amount: 1, requestId: "grant-mock-request-1" }), /prefunded grant pool/);
    await assert.rejects(selectMockProposal({ ...options, rationale: "This is the selected research solution." }), /prefunded grant pool/);
    await assert.rejects(confirmMockProposal(options), /prefunded grant pool/);
    assert.equal([...f.db.records.keys()].filter(path => path.startsWith("mockFunding/")).length, 0);
  });
  it("verifies reciprocal custody and exact balances at a single confirmed block", async () => {
    const f = openFundingFixture(), summary = await getOpenFundingSummary(f);
    assert.equal(summary.totalDeposited, "100000000000"); assert.equal(summary.available, "100000000000");
    assert.equal(summary.poolAddress, poolAddress); assert.equal(summary.canSelect, true);
    assert.equal(summary.selections.length, 2); assert.equal(summary.selections[0].status, "none");
    assert.equal(summary.selections[0].amountBaseUnits, "50000000000"); assert.equal(summary.selections[0].canSelect, true);
    assert(f.calls.every(row => row.blockNumber === 100n));
    f.state.poolOwner = researcher;
    await assert.rejects(getOpenFundingSummary(f), /mismatched ownership/);
    f.state.poolOwner = owner; f.state.availableBalance += 1n;
    await assert.rejects(getOpenFundingSummary(f), /do not reconcile/);
  });
  it("verifies a production posting whose saved audit delivery remains pending", async () => {
    const f = openFundingFixture(); f.posting.audit.status = "pending";
    const read = f.client.readContract;
    f.client.readContract = async request => {
      const actual = await read(request);
      return request.functionName === "getOpportunity"
        ? [actual.owner, actual.kind, actual.contentHash, 0n, 0n, actual.expiresAt, actual.withdrawn]
        : actual;
    };
    const summary = await getOpenFundingSummary(f);
    assert.equal(summary.supported, true); assert.equal(summary.canDeposit, true);
    f.state.poolAddress = zeroAddress;
    const prepared = await prepareOpenFundingAction({ ...f, action: "create" });
    assert.equal(prepared.functionName, "createOpenFundingPool");
    const dashboard = await getFunderDashboard(f);
    assert.equal(dashboard.opportunities[0].pool.exists, false);
    assert.equal(dashboard.opportunities[0].poolUnavailable, false);
  });
  it("requires chain publication instead of accepting queued, unmined or forged receipt metadata", async () => {
    for (const change of [
      f => { f.posting.audit.status = "queued"; f.posting.audit.transactionHash = ""; },
      f => { f.posting.status = "draft"; },
      f => { f.receipts.get(f.posting.audit.transactionHash).status = "reverted"; },
      f => { f.receipts.get(f.posting.audit.transactionHash).status = "pending"; },
      f => { f.receipts.get(f.posting.audit.transactionHash).blockNumber = 101n; },
      f => { f.receipts.get(f.posting.audit.transactionHash).transactionHash = `0x${"6".repeat(64)}`; },
      f => { f.receipts.get(f.posting.audit.transactionHash).to = researcher; },
      f => { f.receipts.get(f.posting.audit.transactionHash).blockHash = `0x${"6".repeat(64)}`; },
      f => { f.posting.ownerId = researcher; },
      f => { f.posting.title = "Altered grant title"; },
    ]) {
      const f = openFundingFixture(); f.posting.audit.status = "pending"; change(f);
      await assert.rejects(getOpenFundingSummary(f), error => error.code === "failed-precondition");
      assert.equal(f.simulations.length, 0);
    }
  });
  it("includes a requested proposal beyond the bounded listing page", async () => {
    const f = openFundingFixture();
    for (const row of f.proposals) f.db.records.delete(`proposals/${row.id}`);
    for (let index = 0; index < 101; index++) f.db.records.set(`proposals/draft-${index}`, { ...f.proposals[0], id: `draft-${index}`, status: "draft" });
    for (const row of f.proposals) f.db.records.set(`proposals/${row.id}`, row);
    const summary = await getOpenFundingSummary({ ...f, proposalId: f.proposals[1].id });
    assert.equal(summary.truncated, true); assert.equal(summary.selections.length, 1);
    assert.equal(summary.selections[0].proposalId, f.proposals[1].id); assert.equal(summary.selections[0].canSelect, true);
  });
  it("restricts creation and token choice to the posted opportunity owner", async () => {
    const f = openFundingFixture(); f.state.poolAddress = zeroAddress;
    assert.equal((await getOpenFundingSummary(f)).exists, false);
    const prepared = await prepareOpenFundingAction({ ...f, action: "create" });
    assert.equal(prepared.functionName, "createOpenFundingPool"); assert.equal(prepared.contractType, "factory");
    assert.deepEqual(prepared.args, [f.expectedPosting.entityId, f.proposals[0].fundingTerms.token]);
    await assert.rejects(prepareOpenFundingAction({ ...f, uid: researcher, action: "create" }), /Only the owner/);
    await assert.rejects(prepareOpenFundingAction({ ...f, action: "create", tokenAddress: researcher }), /supported by this deployment/);
  });
  it("prepares only the owner wallet top-up and keeps expired pools able to top up", async () => {
    const f = openFundingFixture();
    const prepared = await prepareOpenFundingAction({ ...f, action: "deposit", amountBaseUnits: "123450000" });
    assert.equal(prepared.address, poolAddress); assert.deepEqual(prepared.args, ["123450000"]);
    assert.equal(f.simulations[0].account, owner); assert.equal(f.simulations[0].args[0], 123450000n);
    assert.equal(typeof prepared.data, "string"); assert.doesNotThrow(() => JSON.stringify(prepared));
    await assert.rejects(prepareOpenFundingAction({ ...f, uid: researcher, action: "deposit", amountBaseUnits: "1" }), /Only the owner/);
    await assert.rejects(prepareOpenFundingAction({ ...f, action: "deposit", amountBaseUnits: 1.1 }), /integer amount/);
    f.state.timestamp = 2000000001n;
    assert.equal((await getOpenFundingSummary(f)).canDeposit, true);
    assert.equal((await getOpenFundingSummary(f)).canSelect, false);
  });
  it("prepares the initial deposit before approval with zero token allowance", async () => {
    const f = openFundingFixture(); f.state.tokenAllowance = 0n;
    f.client.simulateContract = async request => {
      f.simulations.push(request);
      throw new Error("ERC20InsufficientAllowance");
    };
    const prepared = await prepareOpenFundingAction({ ...f, action: "deposit", amountBaseUnits: "100000000000" });
    assert.equal(prepared.approvalRequired, true); assert.deepEqual(prepared.args, ["100000000000"]);
    assert.equal(prepared.address, poolAddress); assert.equal(f.simulations.length, 0);
    assert.doesNotThrow(() => JSON.stringify(prepared));
    f.state.tokenAllowance = 1n;
    assert.equal((await prepareOpenFundingAction({ ...f, action: "deposit", amountBaseUnits: "100000000000" })).approvalRequired, true);
  });
  it("still rejects insufficient balances and changed token eligibility before asking for approval", async () => {
    for (const change of [
      f => { f.state.walletBalance = 99999999999n; },
      f => { f.state.actualTokenDecimals = 18; },
      f => { f.state.tokenAllowed = false; },
    ]) {
      const f = openFundingFixture(); f.state.tokenAllowance = 0n; change(f);
      await assert.rejects(prepareOpenFundingAction({ ...f, action: "deposit", amountBaseUnits: "100000000000" }), error => error.code === "failed-precondition");
      assert.equal(f.simulations.length, 0);
    }
  });
  it("reserves two 50,000 requests from one 100,000 pool and rejects over-allocation", async () => {
    const f = openFundingFixture();
    const first = await prepareOpenFundingAction({ ...f, proposalId: f.proposals[0].id, action: "select" });
    assert.deepEqual(first.args, [f.expected[0].entityId]); f.select(0);
    const second = await prepareOpenFundingAction({ ...f, proposalId: f.proposals[1].id, action: "select" });
    assert.deepEqual(second.args, [f.expected[1].entityId]); f.select(1);
    const summary = await getOpenFundingSummary(f);
    assert.equal(summary.totalReserved, "100000000000"); assert.equal(summary.available, "0");
    assert.equal(summary.selections.length, 2);
    await assert.rejects(prepareOpenFundingAction({ ...f, proposalId: f.proposals[0].id, action: "select" }), /Only the owner can select/);
  });
  it("restricts selection to the grant owner and to the canonical attached proposal", async () => {
    const f = openFundingFixture();
    await assert.rejects(prepareOpenFundingAction({ ...f, uid: researcher, proposalId: f.proposals[0].id, action: "select" }), /Only the owner/);
    f.state.availableBalance = 49999999999n; f.state.totalDeposited = 49999999999n;
    await assert.rejects(prepareOpenFundingAction({ ...f, proposalId: f.proposals[0].id, action: "select" }), /fit the available pool/);
    const read = f.client.readContract;
    f.client.readContract = request => request.functionName === "openFundingPool" ? zeroAddress : read(request);
    await assert.rejects(prepareOpenFundingAction({ ...f, proposalId: f.proposals[0].id, action: "select" }), /not linked/);
  });
  it("gives each researcher their own seven-day window and expires at its exact boundary", async () => {
    const f = openFundingFixture(); f.select(0); f.select(1);
    const own = await getOpenFundingSummary({ ...f, uid: researcher });
    assert.equal(own.selections.length, 1); assert.equal(own.selections[0].canAccept, true);
    assert.equal((await getOpenFundingSummary({ ...f, uid: otherResearcher })).selections[0].proposalId, f.proposals[1].id);
    const prepared = await prepareOpenFundingAction({ ...f, uid: researcher, proposalId: f.proposals[0].id, action: "accept" });
    assert.equal(prepared.functionName, "acceptProposal");
    await assert.rejects(prepareOpenFundingAction({ ...f, proposalId: f.proposals[0].id, action: "accept" }), /Only the selected proposal owner/);
    await assert.rejects(prepareOpenFundingAction({ ...f, proposalId: f.proposals[0].id, action: "void" }), /after its acceptance deadline/);
    f.state.timestamp += 604800n;
    await assert.rejects(prepareOpenFundingAction({ ...f, uid: researcher, proposalId: f.proposals[0].id, action: "accept" }), /seven-day/);
    assert.equal((await getOpenFundingSummary(f)).selections[0].status, "expired");
    assert.equal((await prepareOpenFundingAction({ ...f, proposalId: f.proposals[0].id, action: "void" })).functionName, "expireProposal");
  });
  it("syncs accepted grants independently and never selects a single posting winner", async () => {
    const f = openFundingFixture(); f.select(0, 2); f.select(1, 2);
    const summary = await syncOpenFunding(f);
    assert.equal(summary.totalAllocated, "100000000000");
    assert.equal(f.db.records.get(`proposals/${f.proposals[0].id}`).status, "accepted");
    assert.equal(f.db.records.get(`proposals/${f.proposals[1].id}`).status, "accepted");
    assert.equal(f.db.records.get(`problems/${f.problemId}`).acceptedProposalId, undefined);
    assert.equal([...f.db.records.keys()].filter(path => path.startsWith("escrowFundingJobs/")).length, 2);
    await assert.rejects(prepareEscrowDeposit({ ...f, proposalId: f.proposals[0].id }), /grant pool/);
    await assert.rejects(startEscrowSettlement({ ...f, proposalId: f.proposals[0].id }), /prefunded open funding pool/);
    assert.equal(fundingBlockReason({ ...f.proposals[1] }, { ...f.posting, acceptedProposalId: f.proposals[0].id }), null);
  });
  it("uses the existing platform release path after grant acceptance and never locks a main-workflow selection", async () => {
    const f = openFundingFixture(); f.select(0, 2);
    const verified = await readVerifiedFunding({ ...f, record: f.proposals[0], parent: f.posting, blockNumber: 100n });
    const options = { ...f, verified, record: f.proposals[0], parent: f.posting,
      job: { selectionRequested: true, selectionId: f.expected[0].entityId }, now: Timestamp.fromMillis(Number(f.state.timestamp) * 1000) };
    assert.equal(settlementAction(options).action.functionName, "release");
    verified.summary.state = "Open";
    assert.equal(settlementAction(options).action, undefined);
    assert.match(settlementAction(options).settlement.message, /researcher accepts the selected offer/);
  });
  it("checks receipt relevance and retains one selection notification across retries", async () => {
    const f = openFundingFixture(), hash = `0x${"7".repeat(64)}`; f.select(0); f.receipt(hash);
    await syncOpenFunding({ ...f, transactionHash: hash }); await syncOpenFunding({ ...f, transactionHash: hash });
    assert.equal([...f.db.records.keys()].filter(path => path.startsWith("moderationNotifications/")).length, 1);
    f.receipts.get(hash).logs[0].address = researcher;
    await assert.rejects(syncOpenFunding({ ...f, transactionHash: hash }), /no confirmed action/);
  });
  it("refreshes the chain head and reports the mined confirmation boundary as retryable", async () => {
    const f = openFundingFixture(), hash = `0x${"7".repeat(64)}`; f.select(0); f.receipt(hash);
    f.receipts.get(hash).blockNumber = 101n;
    let head = 101n;
    f.client.getBlockNumber = async options => { assert.equal(options.cacheTime, 0); return head; };
    await assert.rejects(syncOpenFunding({ ...f, transactionHash: hash }), error => error.code === "unavailable" && /awaiting another chain confirmation/.test(error.message));
    assert.equal([...f.db.records.keys()].filter(path => path.startsWith("openFundingSummaries/")).length, 0);
    head = 102n;
    assert.equal((await syncOpenFunding({ ...f, transactionHash: hash })).selections[0].status, "pending");
    assert.equal(f.simulations.length, 0);
  });
  it("withdraws only unreserved units after closing", async () => {
    const f = openFundingFixture(); f.select(0);
    await assert.rejects(prepareOpenFundingAction({ ...f, action: "withdraw", amountBaseUnits: "1" }), /only after the opportunity closes/);
    f.state.timestamp = 2000000001n;
    await assert.rejects(prepareOpenFundingAction({ ...f, action: "withdraw", amountBaseUnits: "50000000001" }), /exceeds/);
    assert.equal((await prepareOpenFundingAction({ ...f, action: "withdraw", amountBaseUnits: "50000000000" })).functionName, "withdrawAvailable");
  });
});

describe("funder dashboard verified accounting", () => {
  it("records pending and voided grant decisions before any escrow payment", async () => {
    const f = openFundingFixture(); f.select(0); f.select(1, 3);
    const result = await getFunderDashboard(f);
    assert.deepEqual(result.decisions.map(row => row.selection.status), ["pending", "voided"]);
    assert.deepEqual(result.totals, []); assert.equal(result.commitments.length, 0);
  });
  it("lists open grants even when more than fifty main-workflow postings are owned", async () => {
    const f = openFundingFixture(); f.db.records.delete(`problems/${f.problemId}`);
    for (let i = 0; i < 60; i++) f.db.records.set(`problems/main-${i}`, { ownerId: owner, opportunityType: "business-problem", status: "submitted" });
    f.db.records.set(`problems/${f.problemId}`, f.posting);
    assert.equal((await getFunderDashboard(f)).opportunities.length, 1);
  });
  it("lists posted grants and approaches, discovers accepted owner-funded escrows, and totals exact own units", async () => {
    const f = openFundingFixture(); f.select(0, 2); f.select(1, 2);
    f.state.released[0] = 25000000000n; f.state.refunded[0] = 1000000000n;
    await syncOpenFunding(f);
    const result = await getFunderDashboard(f);
    assert.equal(result.opportunities.length, 1); assert.equal(result.approaches.length, 2);
    assert.equal(result.decisions.length, 2); assert.equal(result.commitments.length, 2);
    assert.deepEqual(result.totals[0], { chainId: 421614, tokenAddress: f.proposals[0].fundingTerms.token,
      tokenSymbol: "USDC", tokenDecimals: 6, committed: "100000000000", locked: "74000000000", released: "25000000000", refunded: "1000000000" });
    assert.equal(result.unavailableCommitments, 0);
    const other = await getFunderDashboard({ ...f, uid: researcher });
    assert.equal(other.commitments.length, 0); assert.equal(other.opportunities.length, 0); assert.equal(other.approaches.length, 0);
  });
  it("reports unavailable custody reads without inventing paid funding from Firestore amounts", async () => {
    const f = openFundingFixture(); f.client.getChainId = async () => { throw new Error("Offline"); };
    const result = await getFunderDashboard(f);
    assert.equal(result.opportunities.length, 1); assert.deepEqual(result.totals, []);
    assert.equal(result.opportunities[0].poolUnavailable, true);
    assert.equal(result.commitments.length, 0); assert.equal(result.unavailableCommitments, 2);
  });
});
