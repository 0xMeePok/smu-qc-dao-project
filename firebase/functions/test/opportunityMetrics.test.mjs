import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  affectedProblemIds,
  opportunityMetricsFrom,
} from "../opportunityMetrics.js";

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
        { status: "pledged", amount: 400 },
        { status: "approved", amount: 350 },
        { status: "completed", amount: 500 },
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
