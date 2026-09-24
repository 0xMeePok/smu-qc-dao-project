import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterComparisonRows, recommendationSummary, sortComparisonRows } from "../../src/lib/proposalComparison.js";

const problemMatching = { status: "open", proposalId: null };
const rows = [
  { id: "bravo", title: "Bravo routes", developerName: "Bob", organisation: "Lab", category: "hybrid", amount: 40, currency: "SGD", status: "submitted", qualifyingCount: 2, commentCount: 3, recommendations: { recommend: 2, recommend_with_revisions: 0, do_not_recommend: 0 }, matching: { status: "funding" } },
  { id: "alpha", title: "Alpha annealing", developerName: "Alice", organisation: "SMU", category: "quantum-annealing", amount: 100, currency: "SGD", status: "submitted", qualifyingCount: 1, commentCount: 1, recommendations: { recommend: 0, recommend_with_revisions: 0, do_not_recommend: 1 }, matching: { status: "funding" } },
];

describe("proposal comparison presentation", () => {
  it("[FUT-SPE-158] sorts by title and ignores score or recommendation ordering", () => {
    assert.deepEqual(sortComparisonRows(rows, "title:asc", problemMatching).map((row) => row.id), ["alpha", "bravo"]);
    assert.deepEqual(sortComparisonRows(rows, "score:desc", problemMatching).map((row) => row.id), ["alpha", "bravo"]);
    assert.deepEqual(sortComparisonRows(rows, "recommendation:desc", problemMatching).map((row) => row.id), ["alpha", "bravo"]);
    assert.deepEqual(sortComparisonRows(rows, "amount:desc", problemMatching).map((row) => row.id), ["alpha", "bravo"]);
    assert.deepEqual(sortComparisonRows(rows, "qualifyingCount:desc", problemMatching).map((row) => row.id), ["bravo", "alpha"]);
  });

  it("[FUT-SPE-159] filters by outcome and summarises only recommendations that were given", () => {
    assert.deepEqual(filterComparisonRows(rows, "do_not_recommend").map((row) => row.id), ["alpha"]);
    assert.deepEqual(filterComparisonRows(rows, "").map((row) => row.id), ["bravo", "alpha"]);
    assert.equal(recommendationSummary(rows[1]), "1 Do not recommend");
    assert.equal(recommendationSummary(rows[0]), "2 Recommend");
    assert.equal(recommendationSummary({ qualifyingCount: 0, recommendations: {} }), "No qualifying recommendation");
    assert.equal(recommendationSummary(rows[0]).includes("grade"), false);
  });
});
