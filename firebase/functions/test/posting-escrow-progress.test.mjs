import test from "node:test";
import assert from "node:assert/strict";
import { postingProgressChanged, postingEscrowProgress, refreshPostingEscrowProgress } from "../postingEscrowProgress.js";
import { memoryDb } from "./memoryDb.mjs";
const owner = `0x${"1".repeat(40)}`, researcher = `0x${"2".repeat(40)}`, token = `0x${"3".repeat(40)}`;
const config = { chainId: 421614, address: `0x${"4".repeat(40)}` };
const posting = { ownerId: owner, status: "submitted" };
const proposal = { id: "p1", researcherId: researcher, status: "submitted", audit: { status: "confirmed" }, fundingTerms: { token, target: "90071992547409931234" } };
const summary = { proposalId: proposal.id, researcherId: researcher, postingOwnerId: owner, chainId: config.chainId,
  registryAddress: config.address, tokenAddress: token, tokenDecimals: 6, tokenSymbol: "USDC", fundingTarget: proposal.fundingTerms.target,
  totalDeposited: proposal.fundingTerms.target, totalReleased: "0", totalRefunded: "0", outstandingBalance: proposal.fundingTerms.target,
  custodyBalance: proposal.fundingTerms.target, snapshotVerified: true, timestamp: 1900000000, blockNumber: 100 };
const project = (extra = {}) => postingEscrowProgress({ posting, proposals: [proposal], summaries: [summary], config, ...extra });
test("card triggers ignore keeper heartbeats and text edits, but refresh funding and visibility changes", () => {
  assert.equal(postingProgressChanged("summary", summary, { ...summary, timestamp: summary.timestamp + 1, blockNumber: 101 }), false);
  assert.equal(postingProgressChanged("summary", summary, { ...summary, totalDeposited: "1" }), true);
  assert.equal(postingProgressChanged("proposal", proposal, { ...proposal, title: "Updated explanation" }), false);
  assert.equal(postingProgressChanged("proposal", proposal, { ...proposal, moderationStatus: "removed" }), true);
  assert.equal(postingProgressChanged("posting", posting, { ...posting, amount: 100 }), false);
  assert.equal(postingProgressChanged("posting", posting, { ...posting, moderationStatus: "hidden" }), true);
});
test("marketplace progress keeps large token amounts exact and never uses currency budget", () => {
  const result = project({ posting: { ...posting, amount: 100, currency: "USD" } });
  assert.equal(result.groups[0].fundingTarget, "90071992547409931234");
  assert.equal(result.groups[0].totalDeposited, summary.totalDeposited);
  assert.equal(result.groups[0].fundingRequirementMet, true);
});
test("separates different tokens and excludes hidden or draft proposal custody", () => {
  const otherToken = `0x${"5".repeat(40)}`;
  const result = project({ proposals: [proposal, { ...proposal, id: "p2", fundingTerms: { token: otherToken, target: "10" } },
    { ...proposal, id: "hidden", moderationStatus: "removed" }, { ...proposal, id: "draft", status: "draft" }],
    summaries: [summary, { ...summary, proposalId: "p2", tokenAddress: otherToken, fundingTarget: "10", totalDeposited: "5", outstandingBalance: "5", custodyBalance: "5" }] });
  assert.equal(result.groups.length, 2); assert.equal(result.proposalCount, 2); assert.equal(result.available, true);
  assert.equal(result.groups[1].totalDeposited, "5");
});
test("unverified, mismatched or inconsistent custody cannot become zero or fully funded progress", () => {
  for (const row of [{ ...summary, snapshotVerified: false }, { ...summary, registryAddress: token },
    { ...summary, custodyBalance: "0" }, { ...summary, totalRefunded: "1" }, { ...summary, fundingTarget: "10" }]) {
    const result = project({ summaries: [row] });
    assert.equal(result.available, false); assert.equal(result.unavailableItems, 1); assert.deepEqual(result.groups, []);
  }
  assert.equal(project({ truncated: true }).available, false);
});
test("main proposal escrow progress does not relabel grant pools or removed postings", () => {
  assert.equal(project({ posting: { ...posting, opportunityType: "open-funding" } }), null);
  assert.equal(project({ posting: { ...posting, moderationStatus: "removed" } }), null);
});
test("snapshot-trigger projection preserves listing counts and drops removed proposal amounts", async () => {
  const db = memoryDb({ "problems/posting-1": posting, "proposals/p1": { ...proposal, problemId: "posting-1" },
    "escrowFundingSummaries/s1": { ...summary, problemId: "posting-1" },
    "opportunityMetrics/posting-1": { version: 2, proposalCount: 1, fundedAmount: 0 } });
  await refreshPostingEscrowProgress({ db, problemId: "posting-1", config });
  assert.equal(db.records.get("opportunityMetrics/posting-1").proposalCount, 1);
  assert.equal(db.records.get("opportunityMetrics/posting-1").escrowFunding.groups[0].totalDeposited, summary.totalDeposited);
  db.records.set("proposals/p1", { ...proposal, problemId: "posting-1", moderationStatus: "removed" });
  await refreshPostingEscrowProgress({ db, problemId: "posting-1", config });
  assert.deepEqual(db.records.get("opportunityMetrics/posting-1").escrowFunding.groups, []);
});
test("a rejected, cancelled or refunded escrow is not raised funding or fully funded", () => {
  const refunding = { ...summary, state: "Cancelled", refundsEnabled: true };
  const claimed = { ...summary, state: "Cancelled", totalRefunded: summary.totalDeposited, outstandingBalance: "0", custodyBalance: "0" };
  for (const row of [refunding, claimed, { ...summary, state: "Open", invalidated: true }, { ...summary, state: "Expired" },
    { ...summary, state: "Voided" }, { ...summary, state: "Refunded" }]) {
    const result = project({ summaries: [row] });
    assert.equal(result.available, true);
    assert.equal(result.closedItems, 1);
    assert.deepEqual(result.groups, []);
    assert.equal(result.version, 2);
  }
  // A live sibling still counts; the refunded one does not inflate its totals.
  const live = { ...proposal, id: "p2" };
  const result = project({ proposals: [proposal, live],
    summaries: [refunding, { ...summary, proposalId: "p2", totalDeposited: "5", outstandingBalance: "5", custodyBalance: "5" }] });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].count, 1);
  assert.equal(result.groups[0].totalDeposited, "5");
  assert.equal(result.closedItems, 1);
  assert.equal(postingProgressChanged("summary", summary, { ...summary, refundsEnabled: true }), true);
});
