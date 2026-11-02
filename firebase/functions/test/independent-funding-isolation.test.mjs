import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enqueueEscrowFunding, readVerifiedFunding } from "../escrowFunding.js";
import { readEscrowQueueActions, readGrantQueueMetadata } from "../escrowQueueMetadata.js";
import { seedDashboardSnapshots } from "./fixtures/dashboardSnapshots.js";
import { getFunderDashboard } from "../funderDashboard.js";
import { readIndependentFundingQueueMetadata } from "../independentFundingQueueMetadata.js";
import { memoryDb } from "./memoryDb.mjs";
import { openFundingFixture, owner, researcher } from "./fixtures/openFundingFixture.js";

const independent = { id: "independent", proposalKind: "independent", researcherId: researcher,
  postingOwnerId: owner, status: "submitted", fundingTerms: { target: "100" }, audit: { status: "confirmed" } };

describe("independent funding stays separate from existing escrow workflows", () => {
  it("does not enqueue independent records for the attached-proposal keeper", async () => {
    const db = memoryDb();
    await enqueueEscrowFunding({ db, config: {}, record: independent });
    assert.equal(db.records.size, 0);
  });

  it("rejects the wrong escrow reader before making RPC requests", async () => {
    await assert.rejects(() => readVerifiedFunding({ client: {}, config: {}, record: independent }),
      { code: "failed-precondition" });
  });

  it("does not look up an independent listing as a child proposal in either main queue", async () => {
    const f = openFundingFixture();
    const client = { getChainId: () => assert.fail("Independent rows must not trigger main escrow RPC") };
    const docs = [{ id: independent.id, data: () => independent }];
    const escrow = await readEscrowQueueActions({ ...f, client, uid: researcher, docs });
    const grants = await readGrantQueueMetadata({ ...f, client, uid: researcher, docs, parents: new Map() });
    assert.equal(escrow.actions.length, 0);
    assert.equal(escrow.unavailable.size, 0);
    assert.equal(grants.grants.size, 0);
  });

  it("keeps existing grant decisions functional when an independent listing has no parent", async () => {
    const f = openFundingFixture();
    f.select(0);
    f.db.records.set(`proposals/${independent.id}`, independent);
    await seedDashboardSnapshots(f);
    const dashboard = await getFunderDashboard({ ...f, uid: owner });
    assert.equal(dashboard.opportunities.length, 1);
    assert.equal(dashboard.approaches.length, 2);
    assert.ok(dashboard.decisions.some(row => row.proposalId === f.proposals[0].id && row.selection?.status === "pending"));
    assert.equal(dashboard.approaches.some(row => row.proposalId === independent.id), false);
  });

  it("does not request an RPC head for a dashboard with only independent records", async () => {
    const db = memoryDb({ [`users/${owner}`]: { role: 0 }, [`proposals/${independent.id}`]: independent });
    const client = { getBlockNumber: () => assert.fail("No main custody to verify") };
    const result = await getFunderDashboard({ db, client, uid: owner, config: { chainId: 421614, address: owner } });
    assert.equal(result.blockNumber, null);
    assert.equal(result.approaches.length, 0);
  });
});

describe("independent funding dashboard cache", () => {
  function fixture() {
    const config = { chainId: 421614, address: `0x${"a".repeat(40)}`,
      independentFunding: { enabled: true, factoryAddress: `0x${"b".repeat(40)}` } };
    const summary = { chainId: config.chainId, registryAddress: config.address, factoryAddress: config.independentFunding.factoryAddress,
      state: "Open", totalDeposited: "100", fundingTarget: "100", expiresAt: "2000", completionDeadline: "0" };
    const record = { ...independent, independentFunding: { ...summary, activated: true, locked: true } };
    const key = `independentFundingSummaries/${config.chainId}_${config.address}_${record.id}`;
    const db = memoryDb({ [key]: summary });
    return { db, config, uid: researcher, docs: [{ id: record.id, data: () => record }], now: 1000_000, summary, record };
  }
  it("offers the funded researcher a decision until the funding deadline", async () => {
    const f = fixture();
    const result = await readIndependentFundingQueueMetadata(f);
    assert.equal(result.actions[0].action, "accept_funding");
    assert.equal(result.states.get(independent.id).workflowStatus, "submitted");
    assert.equal((await readIndependentFundingQueueMetadata({ ...f, now: 2000_000 })).actions.length, 0);
  });
  it("uses the completion deadline after acceptance even when the listing has expired", async () => {
    const f = fixture();
    Object.assign(f.summary, { state: "Accepted", expiresAt: "999", completionDeadline: "3000", evidenceHash: `0x${"0".repeat(64)}` });
    assert.equal((await readIndependentFundingQueueMetadata(f)).actions[0].action, "submit_completion");
    Object.assign(f.summary, { evidenceHash: `0x${"1".repeat(64)}`, yesWeight: "50" });
    assert.equal((await readIndependentFundingQueueMetadata(f)).actions.length, 0);
    f.summary.yesWeight = "51";
    assert.equal((await readIndependentFundingQueueMetadata(f)).actions[0].action, "release_completion");
    assert.equal((await readIndependentFundingQueueMetadata({ ...f, now: 3000_000 })).actions.length, 0);
  });
  it("asks each funder to review completion evidence until they vote on that version", async () => {
    const f = fixture();
    const funder = `0x${"d".repeat(40)}`;
    const summaryKey = `${f.config.chainId}_${f.config.address}_${independent.id}`;
    Object.assign(f.summary, { state: "Accepted", evidenceHash: `0x${"1".repeat(64)}`, evidenceVersion: 1,
      completionDeadline: "3000", yesWeight: "0", blockNumber: 4 });
    f.db.records.set(`proposals/${independent.id}`, { ...f.record, title: "Crowdfunded library", status: "accepted" });
    const position = { walletId: funder, proposalId: independent.id, summaryKey,
      chainId: f.config.chainId, registryAddress: f.config.address, factoryAddress: f.config.independentFunding.factoryAddress,
      deposited: "100", hasVoted: false, evidenceVersion: 1, blockNumber: 4 };
    f.db.records.set(`independentFundingPositions/${summaryKey}_${funder}`, position);
    const pending = await readIndependentFundingQueueMetadata({ ...f, uid: funder, docs: [] });
    assert.equal(pending.actions.length, 1);
    assert.equal(pending.actions[0].action, "review_evidence");
    assert.equal(pending.actions[0].title, "Crowdfunded library");
    position.hasVoted = true;
    assert.equal((await readIndependentFundingQueueMetadata({ ...f, uid: funder, docs: [] })).actions.length, 0);
    f.summary.evidenceVersion = 2;
    f.summary.evidenceHash = `0x${"2".repeat(64)}`;
    assert.equal((await readIndependentFundingQueueMetadata({ ...f, uid: funder, docs: [] })).actions[0].action, "review_evidence");
    assert.equal((await readIndependentFundingQueueMetadata({ ...f, uid: funder, docs: [], now: 3000_000 })).actions.length, 0);
    assert.equal((await readIndependentFundingQueueMetadata({ ...f, uid: researcher, docs: f.docs })).actions
      .some(item => item.action === "review_evidence"), false);
  });
  it("does not offer actions from another deployment or moderated listing", async () => {
    const f = fixture();
    f.record.moderationStatus = "removed";
    assert.equal((await readIndependentFundingQueueMetadata(f)).actions.length, 0);
    f.summary.factoryAddress = `0x${"c".repeat(40)}`;
    assert.equal((await readIndependentFundingQueueMetadata(f)).states.size, 0);
  });
});
