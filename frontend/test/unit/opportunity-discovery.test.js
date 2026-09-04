import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_DISCOVERY_FILTERS,
  discoverOpportunities,
  discoveryParams,
  filterOpportunities,
  hasActiveDiscoveryFilters,
  parseDiscoveryParams,
  sortOpportunities,
} from "../../src/lib/opportunityDiscovery.js";

const NOW = new Date("2026-09-04T00:00:00Z");

const OPPORTUNITIES = [
  {
    id: "problem-one",
    opportunityType: "business-problem",
    type: "Business problem",
    organisation: "Meridian Logistics",
    title: "Cold-chain routing",
    summary: "Optimise medicine deliveries with an annealing approach.",
    tags: ["Logistics", "Quantum-inspired"],
    categories: ["quantum", "optimisation"],
    status: "submitted",
    amountValue: 120000,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    expiresAt: new Date("2026-09-10T00:00:00Z"),
  },
  {
    id: "funding-two",
    opportunityType: "open-funding",
    type: "Open funding",
    organisation: "Northpoint Energy",
    title: "Grid forecasting research",
    fundingThesis: "Support practical energy forecasting pilots.",
    tags: ["Energy", "Forecasting"],
    categories: ["ai", "sustainability"],
    status: "open",
    amountValue: 250000,
    createdAt: new Date("2026-09-03T00:00:00Z"),
    expiresAt: new Date("2026-10-20T00:00:00Z"),
  },
  {
    id: "problem-three",
    opportunityType: "business-problem",
    type: "Business problem",
    organisation: "Harborline Trade Services",
    title: "Document provenance",
    summary: "Verify shipping documents without exposing their contents.",
    tags: ["Blockchain"],
    categories: ["web3", "security"],
    status: "submitted",
    amountValue: 95000,
    createdAt: new Date("2026-08-28T00:00:00Z"),
    expiresAt: new Date("2027-01-20T00:00:00Z"),
  },
];

describe("[QCDAO-53] shareable Discover filters", () => {
  it("round-trips supported filters while omitting defaults", () => {
    const filters = {
      ...DEFAULT_DISCOVERY_FILTERS,
      query: "quantum route",
      type: "business-problem",
      category: "quantum",
      status: "submitted",
      minimumFunding: "50000",
      maximumFunding: "150000",
      organisation: "Meridian Logistics",
      timeRemaining: "30",
      sort: "amount-desc",
      page: 2,
    };
    const params = discoveryParams(filters);

    assert.deepEqual(parseDiscoveryParams(params), filters);
    assert.equal(params.get("q"), "quantum route");
    assert.equal(params.get("closing"), "30");
  });

  it("ignores unsupported URL values", () => {
    const parsed = parseDiscoveryParams("type=unknown&category=qaoa&sort=random&closing=forever&min=-2&page=0");
    assert.equal(parsed.type, "");
    assert.equal(parsed.category, "");
    assert.equal(parsed.sort, "newest");
    assert.equal(parsed.timeRemaining, "");
    assert.equal(parsed.minimumFunding, "");
    assert.equal(parsed.page, 1);
  });

  it("searches title, description fields and tags without fuzzy matching", () => {
    assert.deepEqual(filterOpportunities(OPPORTUNITIES, { query: "cold-chain" }, NOW).map(({ id }) => id), ["problem-one"]);
    assert.deepEqual(filterOpportunities(OPPORTUNITIES, { query: "practical energy" }, NOW).map(({ id }) => id), ["funding-two"]);
    assert.deepEqual(filterOpportunities(OPPORTUNITIES, { query: "quantum-inspired" }, NOW).map(({ id }) => id), ["problem-one"]);
    assert.deepEqual(filterOpportunities(OPPORTUNITIES, { query: "cold chane" }, NOW), []);
  });

  it("combines type, quantum category, status, amount, organisation and time filters", () => {
    const matches = filterOpportunities(OPPORTUNITIES, {
      type: "business-problem",
      category: "quantum",
      status: "submitted",
      minimumFunding: "100000",
      maximumFunding: "150000",
      organisation: "Meridian Logistics",
      timeRemaining: "7",
    }, NOW);

    assert.deepEqual(matches.map(({ id }) => id), ["problem-one"]);
  });

  it("does not count the sort choice as an active filter", () => {
    assert.equal(hasActiveDiscoveryFilters({ ...DEFAULT_DISCOVERY_FILTERS, sort: "closing" }), false);
    assert.equal(hasActiveDiscoveryFilters({ ...DEFAULT_DISCOVERY_FILTERS, category: "quantum" }), true);
  });
});

describe("[QCDAO-52] unified opportunity ordering and pagination", () => {
  it("sorts by newest, closing soonest and funding amount", () => {
    assert.deepEqual(sortOpportunities(OPPORTUNITIES, "newest").map(({ id }) => id), ["funding-two", "problem-one", "problem-three"]);
    assert.deepEqual(sortOpportunities(OPPORTUNITIES, "closing").map(({ id }) => id), ["problem-one", "funding-two", "problem-three"]);
    assert.deepEqual(sortOpportunities(OPPORTUNITIES, "amount-desc").map(({ id }) => id), ["funding-two", "problem-one", "problem-three"]);
    assert.deepEqual(sortOpportunities(OPPORTUNITIES, "amount-asc").map(({ id }) => id), ["problem-three", "problem-one", "funding-two"]);
  });

  it("paginates a demo-sized result set and reports the visible range", () => {
    const repeated = Array.from({ length: 13 }, (_, index) => ({
      ...OPPORTUNITIES[0],
      id: `problem-${index}`,
      createdAt: new Date(NOW.getTime() - index * 1000),
    }));
    const result = discoverOpportunities(repeated, {
      ...DEFAULT_DISCOVERY_FILTERS,
      page: 2,
    }, { now: NOW, pageSize: 6 });

    assert.equal(result.totalResults, 13);
    assert.equal(result.totalPages, 3);
    assert.equal(result.page, 2);
    assert.equal(result.firstResult, 7);
    assert.equal(result.lastResult, 12);
    assert.equal(result.items.length, 6);
  });

  it("keeps an over-filtered result distinct from an empty dataset", () => {
    const result = discoverOpportunities(OPPORTUNITIES, {
      ...DEFAULT_DISCOVERY_FILTERS,
      query: "no such opportunity",
    }, { now: NOW });

    assert.equal(OPPORTUNITIES.length > 0, true);
    assert.equal(result.totalResults, 0);
    assert.deepEqual(result.items, []);
  });
});
