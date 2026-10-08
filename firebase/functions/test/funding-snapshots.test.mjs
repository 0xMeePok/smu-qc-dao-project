import assert from "node:assert/strict";
import { it } from "node:test";
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
