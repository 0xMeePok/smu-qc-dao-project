import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { listActionItems, listMyProposals } from "../proposalQueues.js";
import { prepareStoredProposal } from "../proposalAuditPayload.js";
import { getFunderDashboard } from "../funderDashboard.js";
import { FUNDING_EVENTS } from "../escrowFunding.js";
import { openFundingFixture, owner, researcher, otherResearcher } from "./fixtures/openFundingFixture.js";

const nowFor = f => Timestamp.fromMillis(Number(f.state.timestamp) * 1000);
const actions = (f, uid) => listActionItems({ ...f, uid, now: nowFor(f) });

describe("canonical grant queue metadata", () => {
  it("counts only the selected researcher's grant offer and keeps the stored status separate", async () => {
    const f = openFundingFixture(); f.select(0);
    const result = await actions(f, researcher);
    assert.equal(result.total, 1); assert.equal(result.researcher.selectionToAccept.length, 0);
    assert.equal(result.researcher.grantSelectionsToAccept.length, 1);
    assert.equal(result.researcher.grantSelectionsToAccept[0].id, f.proposals[0].id);
    const queue = await listMyProposals({ ...f, uid: researcher });
    assert.equal(queue.items[0].status, "submitted"); assert.equal(queue.items[0].grant.status, "pending");
    assert.equal(queue.items[0].grant.canAccept, true); assert.equal(queue.items[0].grant.amountBaseUnits, "50000000000");
    assert.equal(queue.items[0].grant.deadlineAt, new Date(Number(f.state.timestamp + 604800n) * 1000).toISOString());
    assert.equal((await actions(f, otherResearcher)).researcher.grantSelectionsToAccept.length, 0);
    assert.equal(f.db.records.get(`proposals/${f.proposals[0].id}`).status, "submitted");
  });
  it("uses the complete acceptance window after the posting expires and removes the action at its exact boundary", async () => {
    const f = openFundingFixture(), deadline = 2000000600n;
    f.select(0, 1, deadline); f.state.timestamp = 2000000001n;
    assert.equal((await actions(f, researcher)).total, 1);
    f.state.timestamp = deadline;
    assert.equal((await actions(f, researcher)).total, 0);
    const queue = await listMyProposals({ ...f, uid: researcher });
    assert.equal(queue.items[0].grant.status, "expired"); assert.equal(queue.items[0].grant.canAccept, false);
    assert.equal(f.state.reservedAmount, 50000000000n);
  });
  it("shows canonical acceptance before a worker updates Firestore, and suppresses acceptance for a paused offer", async () => {
    const f = openFundingFixture(); f.select(0, 2);
    let queue = await listMyProposals({ ...f, uid: researcher });
    assert.equal(queue.items[0].status, "submitted"); assert.equal(queue.items[0].grant.status, "accepted");
    assert.equal((await actions(f, researcher)).total, 0);
    f.select(0); f.state.paused = true;
    queue = await listMyProposals({ ...f, uid: researcher });
    assert.equal(queue.items[0].grant.status, "pending"); assert.equal(queue.items[0].grant.canAccept, false);
    assert.equal((await actions(f, researcher)).researcher.grantSelectionsToAccept.length, 0);
  });
  it("exposes availability failures and preserves the historical deployment's queue shape", async () => {
    const f = openFundingFixture(); f.select(0);
    f.client.getChainId = async () => { throw new Error("Offline"); };
    let queue = await listMyProposals({ ...f, uid: researcher });
    assert.equal(queue.unavailableGrantOffers, 1); assert.equal(queue.items[0].grantUnavailable, true);
    assert.equal(queue.items[0].grant, undefined);
    const result = await actions(f, researcher);
    assert.equal(result.unavailableGrantOffers, 1); assert.equal(result.researcher.grantSelectionsToAccept.length, 0);
    delete f.config.escrow.openFundingPoolAbi;
    queue = await listMyProposals({ ...f, uid: researcher });
    assert.equal(queue.unavailableGrantOffers, 0); assert.equal(queue.items[0].grantUnavailable, undefined);
  });
});

function mainFixture() {
  const f = openFundingFixture();
  f.posting.opportunityType = "business-problem";
  f.proposals[0].opportunityType = "business-problem";
  f.expected[0] = prepareStoredProposal(f.proposals[0], { registryConfig: f.config });
  f.db.records.delete(`proposals/${f.proposals[1].id}`);
  f.state.escrowDeposits[0] = 50000000000n;
  const state = { escrowState: 0, currentTranche: 0n, ownerApproved: false, solutionApproved: false,
    evidenceHash: `0x${"0".repeat(64)}` };
  const read = f.client.readContract;
  f.client.readContract = async request => {
    if (request.address === f.addresses[0]) {
      if (request.functionName === "state") return state.escrowState;
      if (["currentTranche", "ownerApproved", "solutionApproved"].includes(request.functionName)) return state[request.functionName];
      if (request.functionName === "milestoneAt") return { ...await read(request), evidenceHash: state.evidenceHash };
    }
    return read(request);
  };
  return { ...f, queueState: state };
}

describe("canonical main escrow action counts", () => {
  it("projects the complete main escrow lifecycle without rewriting a submitted proposal", async () => {
    const f = mainFixture();
    const states = [[0, "Open", "submitted"], [1, "Locked", "pending_approval"], [6, "Active", "accepted"],
      [2, "Released", "completed"], [4, "Cancelled", "cancelled"], [3, "Refunded", "refunded"],
      [5, "Expired", "expired"], [7, "Voided", "invalidated"]];
    for (const [code, name, workflowStatus] of states) {
      f.queueState.escrowState = code; f.queueState.currentTranche = code === 6 ? 1n : 0n;
      const result = await listMyProposals({ ...f, uid: researcher });
      assert.equal(result.items.length, 1);
      const row = result.items[0];
      assert.equal(row.status, "submitted"); assert.equal(row.recordStatus, "submitted");
      assert.equal(row.workflowStatus, workflowStatus); assert.equal(row.escrow.workflowStatus, workflowStatus);
      assert.equal(row.escrow.state, name); assert.equal(row.escrow.blockNumber, 100);
      assert.equal(row.escrow.deadlineAt, [0, 1, 6].includes(code)
        ? new Date(Number(code === 0 ? 2000000000n : 1950000000n) * 1000).toISOString() : null);
      assert.equal(result.unavailableEscrows, 0);
    }
    assert.equal(f.db.records.get(`proposals/${f.proposals[0].id}`).status, "submitted");
    assert.equal(f.db.records.has(`escrowFundingSummaries/${f.proposals[0].id}`), false);
  });
  it("labels the canonical main winner accepted despite a retained pending request and stale record", async () => {
    const f = mainFixture(); f.queueState.escrowState = 6; f.queueState.currentTranche = 1n;
    f.posting.acceptedProposalId = f.proposals[0].id;
    f.posting.escrowSelection = { proposalId: f.proposals[0].id, requestedAt: nowFor(f) };
    f.state.released[0] = 25000000000n;
    const result = await getFunderDashboard({ ...f, uid: owner, now: nowFor(f) });
    assert.equal(result.decisions.length, 1);
    assert.equal(result.decisions[0].selection.status, "accepted");
    assert.equal(result.decisions[0].selection.escrowState, "Active");
    assert.equal(result.decisions[0].recordStatus, "submitted");
    assert.equal(result.decisions[0].escrow.workflowStatus, "accepted");
    assert.equal(f.posting.escrowSelection.proposalId, f.proposals[0].id);
    assert.equal(f.proposals[0].status, "submitted");
  });
  it("removes cancelled escrow review work while retaining held funds until claimed", async () => {
    const f = mainFixture(); f.queueState.escrowState = 4;
    f.db.records.set(`${FUNDING_EVENTS}/deposit`, { actor: owner, eventType: "Deposit", verified: true,
      chainId: f.config.chainId, registryAddress: f.config.address.toLowerCase(), proposalId: f.proposals[0].id });
    const queue = await actions(f, owner);
    assert.equal(queue.owner.awaitingReview.length, 0); assert.equal(queue.escrowActions.length, 0); assert.equal(queue.total, 0);
    const dashboard = await getFunderDashboard({ ...f, uid: owner, now: nowFor(f) });
    assert.equal(dashboard.decisions[0].selection.status, "cancelled");
    assert.equal(dashboard.commitments[0].state, "Cancelled");
    assert.equal(dashboard.commitments[0].committed, "50000000000");
    assert.equal(dashboard.commitments[0].locked, "50000000000");
    assert.equal(dashboard.commitments[0].refunded, "0");
    assert.equal(f.state.escrowDeposits[0], 50000000000n);
  });
  it("does not fabricate canonical status on RPC failure or reinterpret a historical escrow", async () => {
    const f = mainFixture(); f.posting.escrowSelection = { proposalId: f.proposals[0].id };
    f.client.getChainId = async () => { throw new Error("Offline"); };
    let queue = await listMyProposals({ ...f, uid: researcher });
    assert.equal(queue.items[0].escrow, undefined); assert.equal(queue.items[0].escrowUnavailable, true);
    assert.equal(queue.unavailableEscrows, 1);
    const dashboard = await getFunderDashboard({ ...f, uid: owner, now: nowFor(f) });
    assert.equal(dashboard.unavailableDecisions, 1); assert.equal(dashboard.decisions.length, 0);
    assert.equal(dashboard.approaches[0].escrowUnavailable, true);
    assert.equal((await listMyProposals({ ...f, uid: otherResearcher })).items.length, 0);
    f.client.getChainId = async () => f.config.chainId;
    f.receipts.get(f.proposals[0].audit.transactionHash).to = otherResearcher;
    queue = await listMyProposals({ ...f, uid: researcher });
    assert.equal(queue.items[0].escrow, undefined); assert.equal(queue.items[0].escrowUnavailable, undefined);
    assert.equal(queue.items[0].workflowStatus, "submitted"); assert.equal(queue.unavailableEscrows, 0);
  });
  it("reports a truncated owner queue when one posting reaches its proposal page cap", async () => {
    const f = mainFixture();
    f.db.records.delete(`proposals/${f.proposals[0].id}`);
    for (let i = 0; i < 101; i++) {
      const row = { ...f.proposals[0], id: `legacy-${i}` }; delete row.fundingTerms;
      f.db.records.set(`proposals/${row.id}`, row);
    }
    const result = await listActionItems({ db: f.db, uid: owner, now: nowFor(f) });
    assert.equal(result.owner.awaitingReview.length, 100); assert.equal(result.total, 100);
    assert.equal(result.truncated, true);
  });
  it("shows the owner's fully funded selection once rather than duplicating an advisory review", async () => {
    const f = mainFixture(), result = await actions(f, owner);
    assert.equal(result.escrowActions.length, 1); assert.equal(result.escrowActions[0].action, "select");
    assert.equal(result.escrowActions[0].escrowState, "Open"); assert.equal(result.total, 1);
    assert.equal(result.owner.awaitingReview.length, 0);
    assert.equal((await actions(f, researcher)).escrowActions.length, 0);
  });
  it("lists only each party's missing upfront approval at a confirmed block", async () => {
    const f = mainFixture(); f.queueState.escrowState = 1;
    f.client.getBlockNumber = async options => { assert.equal(options.cacheTime, 0); return 103n; };
    assert.equal((await actions(f, owner)).escrowActions[0].action, "approve_upfront");
    assert.equal((await actions(f, researcher)).escrowActions[0].action, "approve_upfront");
    f.queueState.ownerApproved = true;
    assert.equal((await actions(f, owner)).escrowActions.length, 0);
    assert.equal((await actions(f, researcher)).escrowActions.length, 1);
    assert(f.calls.every(row => row.blockNumber === 102n));
  });
  it("moves from researcher delivery submission to missing final approvals and obeys the review deadline", async () => {
    const f = mainFixture(); f.queueState.escrowState = 6; f.queueState.currentTranche = 1n;
    f.proposals[0].status = "accepted";
    assert.equal((await actions(f, researcher)).escrowActions[0].action, "submit_delivery");
    assert.equal((await actions(f, owner)).escrowActions.length, 0);
    f.queueState.evidenceHash = `0x${"1".repeat(64)}`;
    assert.equal((await actions(f, researcher)).escrowActions[0].action, "approve_delivery");
    assert.equal((await actions(f, owner)).escrowActions[0].action, "approve_delivery");
    f.queueState.ownerApproved = true;
    assert.equal((await actions(f, owner)).total, 0);
    f.state.timestamp = 1950000000n;
    assert.equal((await actions(f, researcher)).escrowActions.length, 0);
  });
  it("reports unverifiable escrows, omits historical actions, and exposes no other member's proposal", async () => {
    const f = mainFixture(); f.client.getChainId = async () => { throw new Error("Offline"); };
    assert.equal((await actions(f, researcher)).unavailableEscrows, 1);
    assert.equal((await actions(f, otherResearcher)).unavailableEscrows, 0);
    f.client.getChainId = async () => f.config.chainId;
    f.receipts.get(f.proposals[0].audit.transactionHash).to = otherResearcher;
    const result = await actions(f, researcher);
    assert.equal(result.escrowActions.length, 0); assert.equal(result.unavailableEscrows, 0);
  });
});
