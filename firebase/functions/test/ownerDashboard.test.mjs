import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryDb } from "./memoryDb.mjs";
import { POSTING_CAP, collectOwnerDashboard, summariseOwnerDashboard } from "../ownerDashboard.js";

const FUTURE = { toMillis: () => Date.parse("2099-01-01T00:00:00Z"), toDate: () => new Date("2099-01-01T00:00:00Z") };
const PAST = { toMillis: () => Date.parse("2020-01-01T00:00:00Z"), toDate: () => new Date("2020-01-01T00:00:00Z") };
const NOW = Date.parse("2026-10-03T00:00:00Z");

const posting = (id, extra = {}) => ({ id, status: "submitted", title: `Posting ${id}`, currency: "SGD",
  amount: 1000, expiresAt: FUTURE, ...extra });
const solution = (id, extra = {}) => ({ id, problemId: "p1", status: "submitted", title: `Solution ${id}`,
  currency: "SGD", amount: 100, ...extra });
// What feedbackByProposal returns for one solution.
const feedback = (entries) => new Map(Object.entries(entries));
const counts = (outcomes = [], commentIds = []) => ({
  comments: outcomes.length, qualifying: outcomes.length, recommendations: outcomes,
  recommendationComments: outcomes.map((recommendation, index) => ({
    commentId: commentIds[index] ?? `c${index}`, recommendation, at: "2026-10-01T00:00:00.000Z" })),
});

const find = (summary, id) => summary.postings.find((row) => row.id === id);
const wallet = letter => `0x${letter.repeat(40)}`;
const config = { chainId: 421614, address: wallet("a"), escrow: { tokens: [
  { address: wallet("b"), symbol: "USDC", decimals: 6 },
  { address: wallet("c"), symbol: "ETH", decimals: 18 },
] } };
const escrowSolution = (id, extra = {}) => solution(id, { currency: "USDC", researcherId: wallet("d"),
  postingOwnerId: wallet("e"), audit: { status: "confirmed", chainId: config.chainId },
  fundingTerms: { target: "100000000", token: wallet("b") }, ...extra });
const escrowPosting = (extra = {}) => posting("p1", { ownerId: wallet("e"), ...extra });
const escrowSummary = (id, extra = {}) => ({ proposalId: id, problemId: "p1", postingOwnerId: wallet("e"),
  researcherId: wallet("d"), chainId: config.chainId, registryAddress: config.address,
  escrowAddress: wallet("f"), snapshotVerified: true, blockNumber: 250,
  tokenAddress: wallet("b"), tokenSymbol: "USDC", tokenDecimals: 6, fundingTarget: "100000000",
  totalDeposited: "100000000", totalReleased: "0", totalRefunded: "0", outstandingBalance: "100000000", custodyBalance: "100000000",
  state: "Open", active: true, invalidated: false, timestamp: Math.floor(NOW / 1000),
  expiresAt: String(Math.floor(FUTURE.toMillis() / 1000)),
  custodyLock: { status: "locked", reason: "posting_window", unlockAt: String(Math.floor(FUTURE.toMillis() / 1000)) },
  ...extra });
const escrowDashboard = ({ proposal = escrowSolution("escrow"), snapshot = escrowSummary("escrow"), ...extra } = {}) =>
  summariseOwnerDashboard({ problems: [escrowPosting()], proposals: [proposal], config,
    fundingSummaries: new Map(snapshot ? [[proposal.id, snapshot]] : []), now: NOW, ...extra });

describe("QCDAO-92 problem owner dashboard", () => {
  it("counts the solutions received on each posting and leaves drafts out of them", () => {
    const summary = summariseOwnerDashboard({
      problems: [posting("p1"), posting("p2")],
      proposals: [
        solution("a"),
        solution("b", { status: "draft" }),
        solution("c", { problemId: "p2" }),
        // Moderated away: it exists, but no decision can be taken on it.
        solution("d", { moderationStatus: "removed" }),
      ],
      now: NOW,
    });
    assert.equal(find(summary, "p1").proposalsReceived, 1);
    assert.equal(find(summary, "p2").proposalsReceived, 1);
    assert.equal(summary.totals.proposalsReceived, 2);
  });

  it("reads the funding condition off the solution, not off the posting's requested amount", () => {
    const summary = summariseOwnerDashboard({
      problems: [posting("p1", { amount: 5000 })],
      proposals: [
        // Target 100.00, funded 100.00: fully funded and selectable.
        solution("funded", { amount: 100, matching: { fundedMinor: 10_000 } }),
        solution("short", { id: "short", amount: 100, matching: { fundedMinor: 2_500 } }),
      ],
      now: NOW,
    });
    const row = find(summary, "p1");
    assert.equal(row.fundedSolutions, 1);
    assert.equal(row.fundingCommitted, 125);
    assert.equal(row.fundingTarget, 200);
    assert.equal(row.fundingPercent, 63);
    // The posting asked for 5000; that figure never decides whether selection opens.
    assert.equal(row.requestedAmount, 5000);
    assert.equal(row.readiness.fundingMet, true);
  });

  it("requires the funding target while evaluator recommendations remain optional", () => {
    const base = { problems: [posting("p1")], now: NOW };
    const noFeedback = summariseOwnerDashboard({ ...base,
      proposals: [solution("a", { matching: { fundedMinor: 10_000 } })] });
    assert.equal(find(noFeedback, "p1").readiness.canSelect, true);
    assert.equal(find(noFeedback, "p1").readiness.feedbackRequired, false);
    assert.deepEqual(find(noFeedback, "p1").readiness.blockers, []);

    const noFunding = summariseOwnerDashboard({ ...base,
      proposals: [solution("a")], feedback: feedback({ a: counts(["recommend"]) }) });
    assert.deepEqual(find(noFunding, "p1").readiness.blockers.map((row) => row.kind), ["funding_short"]);

    const ready = summariseOwnerDashboard({ ...base,
      proposals: [solution("a", { matching: { fundedMinor: 10_000 } })],
      feedback: feedback({ a: counts(["recommend"]) }) });
    assert.equal(find(ready, "p1").readiness.canSelect, true);
    assert.deepEqual(find(ready, "p1").readiness.blockers, []);
    assert.equal(ready.totals.readyToSelect, 1);
  });

  it("marks every blocker as someone else's, because none of them is the owner's to fix", () => {
    const summary = summariseOwnerDashboard({
      problems: [posting("empty"), posting("p1")],
      proposals: [solution("a")],
      now: NOW,
    });
    assert.ok(summary.blockers.length > 0);
    assert.equal(summary.blockers.every((row) => row.owner === false), true);
    assert.equal(summary.blockers.find((row) => row.postingId === "empty").kind, "no_solutions");
    assert.equal(summary.totals.blockedPostings, 2);
  });

  it("links each recommendation to the comment that carries it, capped with a count of the rest", () => {
    const outcomes = Array.from({ length: 9 }, () => "recommend");
    const summary = summariseOwnerDashboard({
      problems: [posting("p1")],
      proposals: [solution("a")],
      feedback: feedback({ a: counts(outcomes) }),
      now: NOW,
    });
    const row = find(summary, "p1");
    assert.equal(row.qualifyingRecommendations, 9);
    // Capped for the payload, but the real total is still reported so the UI can
    // say "N more" instead of quietly showing six.
    assert.equal(row.recommendations.length, 6);
    assert.equal(row.recommendations[0].proposalId, "a");
    assert.ok(row.recommendations[0].commentId);
    assert.equal(row.recommendationOutcomes.recommend, 9);
  });

  it("counts a solution with no recommendation as awaiting feedback, once", () => {
    const summary = summariseOwnerDashboard({
      problems: [posting("p1")],
      proposals: [solution("a"), solution("b"), solution("c")],
      feedback: feedback({ a: counts(["do_not_recommend"]) }),
      now: NOW,
    });
    assert.equal(find(summary, "p1").awaitingFeedback, 2);
    assert.equal(summary.totals.awaitingFeedback, 2);
  });

  it("never claims a grant posting is blocked on funding it cannot see", () => {
    const summary = summariseOwnerDashboard({
      problems: [posting("grant", { opportunityType: "open-funding" })],
      proposals: [solution("a", { problemId: "grant", fundingTerms: { target: "100" } })],
      now: NOW,
    });
    // The deposited balance lives in an on-chain pool this module never reads,
    // so asserting a funding shortfall here would be a guess.
    assert.deepEqual(find(summary, "grant").readiness.blockers, []);
    assert.equal(find(summary, "grant").readiness.canSelect, false);
    assert.equal(summary.blockers.length, 0);
  });

  it("separates drafts, live and closed postings and lists accepted solutions", () => {
    const summary = summariseOwnerDashboard({
      problems: [
        posting("draft", { status: "draft" }),
        posting("live"),
        posting("expired", { expiresAt: PAST }),
        posting("done", { hasAcceptedSolution: true, acceptedProposalId: "win" }),
      ],
      proposals: [
        solution("win", { problemId: "done", status: "accepted", updatedAt: FUTURE }),
        solution("open", { problemId: "live" }),
      ],
      now: NOW,
    });
    assert.equal(summary.totals.drafts, 1);
    assert.equal(summary.totals.live, 1);
    assert.equal(summary.totals.closed, 2);
    assert.equal(summary.totals.acceptedSolutions, 1);
    assert.equal(summary.accepted[0].proposalId, "win");
    assert.equal(summary.accepted[0].postingTitle, "Posting done");
    // Drafts sort last: nothing can be submitted against one.
    assert.equal(summary.postings.at(-1).id, "draft");
  });
});

describe("QCDAO-111 owner escrow readiness", () => {
  it("uses the exact confirmed escrow target without requiring evaluator feedback", () => {
    const summary = escrowDashboard();
    const row = find(summary, "p1");
    assert.equal(row.fundedSolutions, 1);
    assert.equal(row.selectableSolutions, 1);
    assert.equal(row.readiness.canSelect, true);
    assert.equal(row.readiness.feedbackRequired, false);
    assert.equal(row.awaitingFeedback, 1);
    assert.equal(summary.totals.readyToSelect, 1);
    assert.equal(row.fundingCommitted, 0);
    assert.equal(row.fundingTarget, 0);
    assert.equal(row.escrowFunding.items[0].fundingTarget, "100000000");
    assert.equal(row.escrowFunding.items[0].custodyLock.status, "locked");
  });

  it("reports an absent confirmed summary as unavailable rather than zero deposits", () => {
    const row = find(escrowDashboard({ snapshot: null }), "p1");
    assert.equal(row.readiness.canSelect, false);
    assert.equal(row.readiness.fundingAvailable, false);
    assert.equal(row.escrowFunding.unavailableItems, 1);
    assert.deepEqual(row.escrowFunding.items, [{ proposalId: "escrow", title: "Solution escrow", available: false }]);
    assert.equal(row.readiness.blockers[0].kind, "funding_unavailable");
    assert.equal(row.escrowFunding.items[0].totalDeposited, undefined);
  });

  it("never treats an old deployment, wrong token or altered target as funding evidence", () => {
    for (const patch of [
      { registryAddress: wallet("9") }, { chainId: 1 }, { tokenAddress: wallet("c") },
      { tokenDecimals: 18 }, { tokenSymbol: "ETH" }, { fundingTarget: "200000000" },
      { proposalId: "other" }, { problemId: "other" }, { postingOwnerId: wallet("9") },
      { researcherId: wallet("9") }, { snapshotVerified: false }, { blockNumber: -1 },
      { custodyBalance: undefined }, { outstandingBalance: "-1" },
    ]) {
      const row = find(escrowDashboard({ snapshot: escrowSummary("escrow", patch) }), "p1");
      assert.equal(row.readiness.canSelect, false, JSON.stringify(patch));
      assert.equal(row.escrowFunding.items[0].available, false, JSON.stringify(patch));
    }
  });

  it("shows genuine zero deposits as zero and keeps a partial deposit below the gate", () => {
    for (const amount of ["0", "99999999"]) {
      const row = find(escrowDashboard({ snapshot: escrowSummary("escrow", {
        totalDeposited: amount, outstandingBalance: amount, custodyBalance: amount,
      }) }), "p1");
      assert.equal(row.escrowFunding.items[0].available, true);
      assert.equal(row.escrowFunding.items[0].totalDeposited, amount);
      assert.equal(row.readiness.canSelect, false);
      assert.equal(row.readiness.blockers[0].kind, "funding_short");
    }
  });

  it("does not let donation excess or missing custody satisfy the exact funding requirement", () => {
    for (const patch of [
      { custodyBalance: "99999999" }, { outstandingBalance: "99999999" },
      { totalDeposited: "100000001", custodyBalance: "100000001", outstandingBalance: "100000001" },
    ]) {
      const row = find(escrowDashboard({ snapshot: escrowSummary("escrow", patch) }), "p1");
      assert.equal(row.readiness.fundingMet, false);
      assert.equal(row.readiness.canSelect, false);
    }
  });

  it("does not show inactive, locked, invalidated, expired or sibling-selected escrow as selectable", () => {
    for (const patch of [
      { active: false }, { state: "Locked" }, { state: "Expired" }, { invalidated: true },
      { expiresAt: String(Math.floor(NOW / 1000)) },
      { pendingProposalEntityId: `0x${"1".repeat(64)}`, proposalEntityId: `0x${"2".repeat(64)}` },
    ]) {
      const row = find(escrowDashboard({ snapshot: escrowSummary("escrow", patch) }), "p1");
      assert.equal(row.readiness.canSelect, false, JSON.stringify(patch));
      assert.equal(row.selectableSolutions, 0);
      assert.equal(row.readiness.blockers[0].kind, "selection_unavailable");
    }
    const row = find(escrowDashboard({ problems: [escrowPosting({ escrowSelection: { proposalId: "other" } })] }), "p1");
    assert.equal(row.readiness.canSelect, false);
  });

  it("checks wall-clock expiry even when the saved block preceded expiry", () => {
    const row = find(escrowDashboard({ snapshot: escrowSummary("escrow", {
      timestamp: Math.floor(NOW / 1000) - 1000,
      expiresAt: String(Math.floor(NOW / 1000) - 1),
    }) }), "p1");
    assert.equal(row.readiness.canSelect, false);
    assert.equal(row.escrowFunding.items[0].canSelect, false);
  });

  it("keeps exact totals grouped by token and separate from legacy currency totals", () => {
    const large = "90071992547409930001";
    const proposals = [escrowSolution("usdc"), escrowSolution("eth", {
      currency: "ETH", fundingTerms: { target: large, token: wallet("c") },
    }), solution("legacy", { amount: 50, matching: { fundedMinor: 1250 } })];
    const row = find(summariseOwnerDashboard({ problems: [escrowPosting()], proposals, config, now: NOW,
      fundingSummaries: new Map([
        ["usdc", escrowSummary("usdc")],
        ["eth", escrowSummary("eth", { tokenAddress: wallet("c"), tokenSymbol: "ETH", tokenDecimals: 18,
          fundingTarget: large, totalDeposited: large, outstandingBalance: large, custodyBalance: large })],
      ]) }), "p1");
    assert.equal(row.fundingTarget, 50);
    assert.equal(row.fundingCommitted, 12.5);
    assert.equal(row.escrowFunding.totals.length, 2);
    assert.equal(row.escrowFunding.totals.find(total => total.tokenSymbol === "ETH").totalDeposited, large);
    assert.equal(row.escrowFunding.totals.find(total => total.tokenSymbol === "USDC").totalDeposited, "100000000");
  });
});

describe("QCDAO-92 owner dashboard reads", () => {
  it("reads every solution on every owned posting in one query and reports a cap", async () => {
    const db = memoryDb();
    await db.collection("users").doc("0xowner").set({ role: 0 });
    await db.collection("problems").doc("p1").set({ ownerId: "0xowner", status: "submitted", title: "Mine", expiresAt: FUTURE });
    await db.collection("problems").doc("other").set({ ownerId: "0xsomeone", status: "submitted", title: "Theirs" });
    await db.collection("proposals").doc("a").set({ postingOwnerId: "0xowner", problemId: "p1", status: "submitted", title: "A" });
    // Belongs to a posting outside this response; counting it against p1 would
    // attribute someone else's solution to this owner.
    await db.collection("proposals").doc("b").set({ postingOwnerId: "0xowner", problemId: "ghost", status: "submitted", title: "B" });

    const seen = [];
    const summary = await collectOwnerDashboard({ db, uid: "0xowner", now: NOW,
      readFeedback: async (ignored, ids) => { seen.push(...ids); return new Map(); } });

    assert.deepEqual(summary.postings.map((row) => row.id), ["p1"]);
    assert.equal(summary.totals.proposalsReceived, 1);
    assert.deepEqual(seen, ["a"]);
    assert.equal(summary.truncated.postings, false);
    assert.equal(POSTING_CAP > 0, true);
  });

  it("refuses a suspended member rather than returning their postings", async () => {
    const db = memoryDb();
    await db.collection("users").doc("0xowner").set({ role: 0, suspended: true });
    await assert.rejects(
      () => collectOwnerDashboard({ db, uid: "0xowner", readFeedback: async () => new Map() }),
      /active member profile/i,
    );
  });

  it("consumes the shared funding reader once after member authorization", async () => {
    const db = memoryDb();
    await db.collection("users").doc(wallet("e")).set({ role: 0 });
    await db.collection("problems").doc("p1").set(escrowPosting());
    await db.collection("proposals").doc("escrow").set(escrowSolution("escrow"));
    let reads = 0;
    const summary = await collectOwnerDashboard({ db, uid: wallet("e"), config, now: NOW,
      readFeedback: async () => new Map(),
      readFundingSummary: async ({ uid }) => { reads++; assert.equal(uid, wallet("e"));
        return { items: [escrowSummary("escrow")], unavailableItems: 0, truncated: true }; },
    });
    assert.equal(reads, 1);
    assert.equal(summary.totals.readyToSelect, 1);
    assert.equal(summary.truncated.funding, true);

    await db.collection("users").doc(wallet("e")).set({ role: 0, suspended: true });
    await assert.rejects(() => collectOwnerDashboard({ db, uid: wallet("e"), config,
      readFeedback: async () => new Map(), readFundingSummary: async () => { reads++; },
    }), /active member profile/i);
    assert.equal(reads, 1);
  });

  it("preserves the posting overview when the shared funding reader is temporarily unavailable", async () => {
    const db = memoryDb();
    await db.collection("users").doc(wallet("e")).set({ role: 0 });
    await db.collection("problems").doc("p1").set(escrowPosting());
    await db.collection("proposals").doc("escrow").set(escrowSolution("escrow"));
    const summary = await collectOwnerDashboard({ db, uid: wallet("e"), config, now: NOW,
      readFeedback: async () => new Map(), readFundingSummary: async () => { throw new Error("RPC unavailable"); },
    });
    assert.equal(summary.totals.proposalsReceived, 1);
    assert.equal(summary.postings[0].escrowFunding.unavailableItems, 1);
    assert.equal(summary.postings[0].readiness.canSelect, false);
  });
});
