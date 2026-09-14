import { backfillMetricsPage } from "../metricsMigration.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  affectedProblemIds,
  opportunityMetricsFrom,
  affectsMetrics,
  syncMetricContribution,
} from "../opportunityMetrics.js";
import { memoryDb } from "./memoryDb.mjs";

describe("opportunity marketplace metrics", () => {
  it("counts submitted proposal records but not drafts or withdrawals", () => {
    const metrics = opportunityMetricsFrom({
      proposals: [
        { status: "draft" },
        { status: "submitted" },
        { status: "under_review" },
        { status: "accepted" },
        { status: "rejected" },
        { status: "withdrawn" },
      ],
      requestedAmount: 1000,
    });

    assert.equal(metrics.proposalCount, 4);
  });

  it("sums live funding records and caps displayed progress at 100 percent", () => {
    const metrics = opportunityMetricsFrom({
      funding: [
        { status: "pledged", amount: 400, verification: { status: "verified" } },
        { status: "approved", amount: 350, verification: { status: "verified" } },
        { status: "completed", amount: 500, verification: { status: "verified" } },
        { status: "cancelled", amount: 900 },
        { status: "approved", amount: -20 },
      ],
      requestedAmount: 1000,
    });

    assert.deepEqual(metrics, {
      proposalCount: 0,
      fundedAmount: 1250,
      fundingProgressPercent: 100,
    });
  });

  it("returns a stable zero placeholder until related records exist", () => {
    assert.deepEqual(opportunityMetricsFrom({ requestedAmount: 250000 }), {
      proposalCount: 0,
      fundedAmount: 0,
      fundingProgressPercent: 0,
    });
  });

  it("refreshes both records when an administrative move changes problem id", () => {
    const event = {
      data: {
        before: { data: () => ({ problemId: "problem-before" }) },
        after: { data: () => ({ problemId: "problem-after" }) },
      },
    };
    assert.deepEqual(affectedProblemIds(event), ["problem-before", "problem-after"]);
  });

  it("deduplicates the normal update path and handles deletes", () => {
    const update = {
      data: {
        before: { data: () => ({ problemId: "problem-one" }) },
        after: { data: () => ({ problemId: "problem-one" }) },
      },
    };
    const deletion = {
      data: {
        before: { data: () => ({ problemId: "problem-one" }) },
        after: { data: () => undefined },
      },
    };
    assert.deepEqual(affectedProblemIds(update), ["problem-one"]);
    assert.deepEqual(affectedProblemIds(deletion), ["problem-one"]);
  });
});

describe("QCDAO-133/139 bounded metrics", () => {
  it("ignores client-era funding in every counted lifecycle state", () => {
    assert.equal(opportunityMetricsFrom({ funding: ["pledged", "approved", "disbursing", "completed"]
      .map((status) => ({ status, amount: 1000000 })) }).fundedAmount, 0);
  });
  it("does no refresh for draft creation, deletion or text edits", () => {
    for (const [before, after] of [[null, { status: "draft" }], [{ status: "draft" }, null],
      [{ status: "draft", title: "A" }, { status: "draft", title: "B" }]]) {
      assert.equal(affectsMetrics("proposals", { data: {
        before: { data: () => before && { problemId: "p", ...before } },
        after: { data: () => after && { problemId: "p", ...after } },
      } }), false);
    }
  });
  it("bounds reads with 10,000 drafts and survives duplicates, concurrency, moves and deletes", async () => {
    const db = memoryDb({ "problems/p": { amount: 1000 }, "problems/q": { amount: 500 },
      ...Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`proposals/d${i}`, { status: "draft", problemId: "p" }])),
      "proposals/live": { status: "submitted", problemId: "p" },
    });
    const sync = () => syncMetricContribution({ db, collectionName: "proposals", recordId: "live", updatedAt: 1 });
    await Promise.all([sync(), sync(), sync()]);
    assert.equal(db.records.get("opportunityMetrics/p").proposalCount, 1);
    assert.equal(db.reads, 8);
    db.records.set("proposals/live", { status: "submitted", problemId: "q" });
    await sync();
    assert.equal(db.records.get("opportunityMetrics/p").proposalCount, 0);
    assert.equal(db.records.get("opportunityMetrics/q").proposalCount, 1);
    db.records.delete("proposals/live");
    await sync(); await sync();
    assert.equal(db.records.get("opportunityMetrics/q").proposalCount, 0);
  });
});


it("QCDAO-133/139 migrates historical totals in bounded pages and safely resumes", async () => {
  const db = memoryDb({ "problems/p": { amount: 1000 },
    "opportunityMetrics/p": { proposalCount: 2, fundedAmount: 999999 },
    "proposals/a": { problemId: "p", status: "submitted" },
    "proposals/b": { problemId: "p", status: "accepted" },
    "funding/forged": { problemId: "p", status: "completed", amount: 999999 },
    "funding/verified": { problemId: "p", status: "completed", amount: 100, verification: { status: "verified" } },
  });
  let done = false;
  for (let i = 0; i < 12 && !done; i++) {
    const result = await backfillMetricsPage({ db, now: 1, pageSize: 1 });
    assert.ok(result.scanned <= 1);
    done = result.done;
  }
  assert.equal(done, true);
  assert.equal(db.records.get("opportunityMetrics/p").proposalCount, 2);
  assert.equal(db.records.get("opportunityMetrics/p").fundedAmount, 100);
  assert.deepEqual(await backfillMetricsPage({ db, now: 2 }), { done: true, scanned: 0 });
  await syncMetricContribution({ db, collectionName: "proposals", recordId: "a", updatedAt: 3 });
  assert.equal(db.records.get("opportunityMetrics/p").proposalCount, 2);
});


it("treats differently ordered Firestore map fields as the same contribution", async () => {
  const saved = { fundedAmount: 0, proposalCount: 1, problemId: "p" };
  const db = memoryDb({ "proposals/a": { problemId: "p", status: "submitted" }, "metricContributions/proposals_a": saved });
  await syncMetricContribution({ db, collectionName: "proposals", recordId: "a", updatedAt: 1 });
  assert.equal(db.reads, 2);
  assert.equal(db.records.get("metricContributions/proposals_a"), saved);
});
