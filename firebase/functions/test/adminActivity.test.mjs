import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryDb } from "./memoryDb.mjs";
import { ACCESS_LEVELS, collectAdminActivity, summariseActivity } from "../adminActivity.js";

const FUTURE = { toMillis: () => Date.parse("2099-01-01T00:00:00Z") };
const PAST = { toMillis: () => Date.parse("2020-01-01T00:00:00Z") };
const NOW = Date.parse("2026-10-03T00:00:00Z");

const problem = (id, extra = {}) => ({ id, status: "submitted", expiresAt: FUTURE, ...extra });
const proposal = (id, extra = {}) => ({ id, problemId: "p1", status: "submitted", ...extra });

describe("QCDAO-140 platform activity counts", () => {
  it("counts people by access level, not by stakeholder capability", () => {
    const summary = summariseActivity({
      users: [{ role: 0 }, { role: 0, suspended: true }, { role: 2 }, { role: 1 }, {}],
      now: NOW,
    });
    // An account with no stored role is a platform user, same as role 0.
    assert.equal(summary.users.byRole.user, 3);
    assert.equal(summary.users.byRole.evaluator, 1);
    assert.equal(summary.users.byRole.administrator, 1);
    assert.equal(summary.users.total, 5);
    assert.equal(summary.users.suspended, 1);
    assert.deepEqual(ACCESS_LEVELS.map(([, name]) => name), ["user", "evaluator", "administrator"]);
  });

  it("treats expired and moderated postings as inactive without losing them from the total", () => {
    const summary = summariseActivity({
      problems: [
        problem("live"),
        problem("expired", { expiresAt: PAST }),
        problem("hidden", { moderationStatus: "hidden" }),
        problem("draft", { status: "draft" }),
      ],
      now: NOW,
    });
    assert.equal(summary.postings.active, 1);
    assert.equal(summary.postings.total, 4);
  });

  it("counts a posting as gated while any live solution has no qualifying recommendation", () => {
    const summary = summariseActivity({
      problems: [problem("p1"), problem("p2"), problem("closed", { status: "draft" })],
      proposals: [
        proposal("a", { problemId: "p1" }),
        // A second ungated solution on the same posting does not clear the gate.
        proposal("b", { problemId: "p1", matching: { evaluationComplete: true } }),
        proposal("c", { problemId: "p2", matching: { evaluationComplete: true } }),
        // Gated, but its posting is not live, so no owner is waiting on it.
        proposal("d", { problemId: "closed" }),
      ],
      now: NOW,
    });
    assert.equal(summary.postings.feedbackGatesOutstanding, 1);
    assert.equal(summary.proposals.open, 4);
  });

  it("ignores moderated solutions and counts owner selections in progress", () => {
    const summary = summariseActivity({
      problems: [problem("p1")],
      proposals: [
        proposal("hidden", { moderationStatus: "hidden" }),
        proposal("picked", { matching: { status: "awaiting_confirmation", evaluationComplete: true } }),
        proposal("open"),
      ],
      now: NOW,
    });
    assert.equal(summary.proposals.selectionsInProgress, 1);
    // The hidden solution is excluded from the gate calculation entirely.
    assert.equal(summary.postings.feedbackGatesOutstanding, 1);
  });

  it("counts only visible, qualifying recommendation comments", () => {
    const summary = summariseActivity({
      comments: [
        { qualifying: true },
        { qualifying: true, moderationStatus: "hidden" },
        { qualifying: true, moderationStatus: "removed" },
        { qualifying: true, deletedAt: {} },
        { qualifying: false },
      ],
      now: NOW,
    });
    assert.equal(summary.evaluatorFeedback.qualifyingComments, 1);
  });

  it("sums escrow targets as exact base units, never as a float", () => {
    // Beyond Number.MAX_SAFE_INTEGER on purpose: parsing these would round.
    const summary = summariseActivity({
      proposals: [
        proposal("a", { fundingTerms: { target: "90071992547409910000" } }),
        proposal("b", { fundingTerms: { target: "1" } }),
        proposal("c", { fundingTerms: { target: "not-a-number" } }),
        proposal("d", { matching: { fundedMinor: 250_00 } }),
      ],
      now: NOW,
    });
    assert.equal(summary.escrow.targetBaseUnits, "90071992547409910001");
    // A malformed target is skipped, not allowed to fail the whole dashboard.
    assert.equal(summary.escrow.backedProposals, 3);
    assert.equal(summary.escrow.mockFunded, 250);
  });

  it("reports what still needs an administrator", () => {
    const summary = summariseActivity({
      moderationPending: 4,
      anchorJobs: [{ status: "failed" }, { status: "failed" }, { status: "pending" }],
      now: NOW,
    });
    assert.equal(summary.moderation.pending, 4);
    assert.equal(summary.anchoring.failed, 2);
  });

  it("reads every collection it reports on and flags a capped scan", async () => {
    const db = memoryDb({
      "users/a": { role: 0 }, "users/b": { role: 2 },
      "problems/p1": { status: "submitted", expiresAt: FUTURE },
      "proposals/s1": { problemId: "p1", status: "submitted" },
      "comments/c1": { qualifying: true, proposalId: "s1" },
      "moderationStats/global": { pendingCount: 3 },
      "proposalAuditJobs/j1": { status: "failed" },
    });
    const summary = await collectAdminActivity({ db, now: NOW });
    assert.equal(summary.users.total, 2);
    assert.equal(summary.postings.active, 1);
    assert.equal(summary.proposals.open, 1);
    assert.equal(summary.evaluatorFeedback.qualifyingComments, 1);
    assert.equal(summary.moderation.pending, 3);
    assert.equal(summary.anchoring.failed, 1);
    assert.equal(summary.postings.feedbackGatesOutstanding, 1);
    assert.equal(Object.values(summary.truncated).some(Boolean), false);

    // A count that silently stopped at the cap would be worse than none.
    const capped = await collectAdminActivity({ db, now: NOW, cap: 1 });
    assert.equal(capped.truncated.users, true);
  });
});
