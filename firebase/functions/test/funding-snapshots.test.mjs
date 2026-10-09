import assert from "node:assert/strict";
import { it } from "node:test";
import { signalActivity } from "../activitySignals.js";
import { memoryDb } from "./memoryDb.mjs";
import { saveFundingSnapshot, OPEN_FUNDING_SELECTIONS } from "../fundingSnapshots.js";
import { deploymentKey } from "../escrowFunding.js";
import { getOpenFundingSummary, saveOpenFundingSnapshot, OPEN_FUNDING_SUMMARIES } from "../openFunding.js";
import { openFundingFixture, owner, researcher } from "./fixtures/openFundingFixture.js";

it("does not let a slower old verified read replace a newer dashboard snapshot", async () => {
  const db = memoryDb();
  const options = { db, collection: "positions", id: "current_deployment_wallet" };
  await saveFundingSnapshot({ ...options, snapshot: { blockNumber: 120, released: "500" } });
  assert.equal(await saveFundingSnapshot({ ...options, snapshot: { blockNumber: 100, released: "0" } }), false);
  assert.equal(db.records.get("positions/current_deployment_wallet").released, "500");
  assert.equal(await saveFundingSnapshot({ ...options, snapshot: { blockNumber: undefined, released: "0" } }), false);
});

it("detail verification stores public pool totals separately from caller-scoped private offers", async () => {
  const f = openFundingFixture(); f.select(0); f.select(1);
  const result = await getOpenFundingSummary(f);
  const prefix = deploymentKey(f.config);
  const totals = f.db.records.get(`${OPEN_FUNDING_SUMMARIES}/${prefix}_${f.problemId}`);
  assert.equal(totals.totalReserved, result.totalReserved);
  assert.equal("selections" in totals, false);
  const firstPath = `${OPEN_FUNDING_SELECTIONS}/${prefix}_${f.proposals[0].id}`;
  const secondPath = `${OPEN_FUNDING_SELECTIONS}/${prefix}_${f.proposals[1].id}`;
  assert.equal(f.db.records.get(firstPath).owner, owner);
  assert.equal(f.db.records.get(firstPath).status, "pending");
  assert.equal("canAccept" in f.db.records.get(firstPath), false);
  const second = f.db.records.get(secondPath);
  await getOpenFundingSummary({ ...f, uid: researcher });
  assert.equal(f.db.records.get(secondPath), second, "A researcher's partial view must not erase another proposal's offer");
});

it("older pool and selection snapshots cannot restore a spent reservation", async () => {
  const f = openFundingFixture(); f.select(0);
  const old = await getOpenFundingSummary(f);
  const updated = { ...old, blockNumber: old.blockNumber + 1, totalAllocated: old.totalReserved,
    totalReserved: "0", selections: old.selections.map(row => ({ ...row, status: "accepted" })) };
  await saveOpenFundingSnapshot({ ...f, summary: updated });
  await saveOpenFundingSnapshot({ ...f, summary: old });
  const prefix = deploymentKey(f.config);
  assert.equal(f.db.records.get(`${OPEN_FUNDING_SUMMARIES}/${prefix}_${f.problemId}`).totalReserved, "0");
  assert.equal(f.db.records.get(`${OPEN_FUNDING_SELECTIONS}/${prefix}_${f.proposals[0].id}`).status, "accepted");
});

it("emits atomic funding counters only for meaningful verified changes, not refreshes or old blocks", async () => {
  const db = memoryDb();
  const options = { db, collection: "escrowFundingSummaries", id: "current" };
  const initial = { proposalId: "p", problemId: "problem", blockNumber: 100, totalDeposited: "100", totalReleased: "0", fundingActivityVersion: 1 };
  await saveFundingSnapshot({ ...options, snapshot: initial });
  for (const path of ["proposals/p/activity/latest", "problems/problem/activity/latest"]) assert.deepEqual(db.records.get(path), { funding: 1 });
  await saveFundingSnapshot({ ...options, snapshot: { ...initial, blockNumber: 101, timestamp: 123, confirmedAt: "later", snapshotVerified: true } });
  assert.equal(db.records.get("proposals/p/activity/latest").funding, 1);
  await saveFundingSnapshot({ ...options, snapshot: { ...initial, blockNumber: 99, totalDeposited: "1" } });
  assert.equal(db.records.get("proposals/p/activity/latest").funding, 1);
  await saveFundingSnapshot({ ...options, snapshot: { ...initial, blockNumber: 102, fundingActivityVersion: 2 } });
  assert.equal(db.records.get("proposals/p/activity/latest").funding, 2, "Anchored milestone or approval changes invalidate even without a balance change");
  await saveFundingSnapshot({ ...options, snapshot: { ...initial, blockNumber: 103, fundingActivityVersion: 2, totalReleased: "50" } });
  assert.equal(db.records.get("proposals/p/activity/latest").funding, 3);
});

it("grant-pool snapshots ignore caller permissions but signal a reservation change to both affected pages", async () => {
  const f = openFundingFixture();
  const initial = await getOpenFundingSummary(f);
  const path = `problems/${f.problemId}/activity/latest`;
  const counter = f.db.records.get(path).funding;
  await saveOpenFundingSnapshot({ ...f, summary: { ...initial, blockNumber: initial.blockNumber,
    timestamp: initial.timestamp + 10, canCreate: true, canDeposit: false, canSelect: false, canWithdraw: true } });
  assert.equal(f.db.records.get(path).funding, counter);
  f.select(0);
  await getOpenFundingSummary(f);
  assert.ok(f.db.records.get(path).funding > counter);
  assert.ok(f.db.records.get(`proposals/${f.proposals[0].id}/activity/latest`).funding > 0);
});


it("separate activity counters merge atomically and roll back with a failed transaction", async () => {
  const db = memoryDb();
  const entity = { proposalId: "atomic", problemId: "parent" };
  await Promise.all(["comments", "funding", "comments"].map(topic => db.runTransaction(async tx => {
    signalActivity(tx, db, entity, topic);
  })));
  for (const path of ["proposals/atomic/activity/latest", "problems/parent/activity/latest"]) {
    assert.deepEqual(db.records.get(path), { comments: 2, funding: 1 });
  }
  await assert.rejects(db.runTransaction(async tx => {
    signalActivity(tx, db, entity, "funding");
    throw new Error("Snapshot write failed");
  }), /Snapshot write failed/);
  assert.deepEqual(db.records.get("proposals/atomic/activity/latest"), { comments: 2, funding: 1 });
});
