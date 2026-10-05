import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  BLOCKER_LABELS, byUrgency, developerAttention, discussionCountLabel, ownerAttention,
} from "../../src/lib/dashboardAttention.js";

/** QCDAO-92/93 - the attention panel shared by both role dashboards. */

const SOON = "2026-10-04T00:00:00.000Z";
const LATER = "2026-10-20T00:00:00.000Z";

const item = (id, extra = {}) => ({ id, title: `Solution ${id}`, problemId: "p1",
  posting: { id: "p1", title: "Cold-chain routing" }, submittedAt: "2026-09-01T00:00:00.000Z", ...extra });

describe("attention ordering", () => {
  it("puts the soonest deadline first and undated work last", () => {
    const order = byUrgency([
      { key: "none", deadlineAt: null, submittedAt: "2026-09-02T00:00:00.000Z" },
      { key: "later", deadlineAt: LATER },
      { key: "soon", deadlineAt: SOON },
      { key: "older", deadlineAt: null, submittedAt: "2026-09-01T00:00:00.000Z" },
    ]).map((row) => row.key);
    // A lapsed window invalidates the posting; nothing else here gets worse by
    // waiting, so the dated items lead and the newest submission breaks the tie.
    assert.deepEqual(order, ["soon", "later", "none", "older"]);
  });
});

describe("QCDAO-92 what is blocked on the owner", () => {
  it("offers selection and review, and routes a pooled selection to the posting's match panel", () => {
    const rows = ownerAttention({
      owner: { readyToSelect: [item("s1")], awaitingReview: [item("r1")] },
    });
    const select = rows.find((row) => row.kind === "select");
    assert.equal(select.route, "posting/p1?tab=funding");
    assert.equal(rows.find((row) => row.kind === "review").route, "proposal/r1?tab=feedback");
  });

  it("routes an escrow-backed selection to the proposal's own escrow screen", () => {
    const rows = ownerAttention({ owner: { readyToSelect: [item("s1", { fundingTerms: { target: "1" } })] } });
    assert.equal(rows[0].route, "proposal/s1?tab=funding");
  });

  it("claims only the escrow steps on a posting this owner actually owns", () => {
    const actions = { escrowActions: [
      item("mine", { action: "approve_upfront", problemId: "p1", deadlineAt: SOON }),
      item("theirs", { action: "approve_upfront", problemId: "p9", deadlineAt: SOON }),
      // The author's own step, never the owner's, whoever the posting belongs to.
      item("author", { action: "submit_delivery", problemId: "p1" }),
    ] };
    const rows = ownerAttention(actions, new Set(["p1"]));
    assert.deepEqual(rows.map((row) => row.id), ["mine"]);
    assert.equal(rows[0].dual, true);
  });

  it("returns nothing rather than throwing when there are no action items yet", () => {
    assert.deepEqual(ownerAttention(undefined), []);
    assert.deepEqual(ownerAttention(null, new Set()), []);
  });
});

describe("QCDAO-93 what is blocked on the solution author", () => {
  it("names the dual approval and counts down to it", () => {
    const rows = developerAttention({
      researcher: { selectionToAccept: [item("a1", { deadlineAt: SOON })],
        grantSelectionsToAccept: [item("g1", { deadlineAt: LATER })] },
    });
    assert.deepEqual(rows.map((row) => row.kind), ["accept", "grant"]);
    assert.equal(rows[0].dual, true);
    assert.match(rows[0].note, /Both parties must accept/);
    assert.match(rows[0].note, /invalidates the posting/);
    assert.equal(rows[0].route, "posting/p1?tab=funding");
    // A grant offer is one-sided: the owner already committed the funds.
    assert.equal(rows[1].dual, false);
  });

  it("claims only the escrow steps on solutions this member authored", () => {
    const actions = { escrowActions: [
      item("mine", { action: "submit_delivery" }),
      item("theirs", { action: "submit_delivery" }),
      // The owner's own step, even on a solution this member wrote.
      item("mine", { action: "select" }),
    ] };
    const rows = developerAttention(actions, new Set(["mine"]));
    assert.deepEqual(rows.map((row) => row.kind), ["escrow-submit_delivery"]);
  });
});

describe("QCDAO-93 discussion count", () => {
  it("counts only the comments that are not evaluator filings", () => {
    assert.equal(discussionCountLabel({ comments: 5, qualifying: 2 }), "3 discussion comments");
    assert.equal(discussionCountLabel({ comments: 2, qualifying: 1 }), "1 discussion comment");
    assert.equal(discussionCountLabel({}), "0 discussion comments");
    // A rebuilt recommendation map can momentarily exceed the visible count;
    // a negative total would be worse than none.
    assert.equal(discussionCountLabel({ comments: 1, qualifying: 3 }), "0 discussion comments");
  });
});

describe("blocker labels", () => {
  it("names every blocker the owner dashboard can emit", () => {
    assert.deepEqual(Object.keys(BLOCKER_LABELS).sort(),
      ["feedback_missing", "funding_short", "no_solutions"]);
  });
});

describe("dashboard deep links reach the tab they name", () => {
  // Both dashboards link to ?tab= values. If the router stops accepting one,
  // the link still opens the page and silently lands on Overview, so the
  // allow-lists are asserted here rather than left to a manual click.
  const app = readFileSync(new URL("../../src/App.jsx", import.meta.url), "utf8");

  it("accepts every proposal tab the dashboards link to", () => {
    assert.match(app, /ProposalDetailPage[\s\S]*?initialTab=\{initialTab\(params, \["funding", "feedback", "record"\]\)\}/);
  });

  it("accepts every posting tab the owner dashboard links to", () => {
    assert.match(app, /PostingDetailPage[\s\S]*?initialTab=\{initialTab\(params, \["proposals", "funding", "record"\]\)\}/);
  });

  it("falls back to overview rather than rendering an unknown tab", () => {
    assert.match(app, /function initialTab\(params, allowed\) \{[\s\S]*?allowed\.includes\(requested\) \? requested : "overview"/);
  });
});
