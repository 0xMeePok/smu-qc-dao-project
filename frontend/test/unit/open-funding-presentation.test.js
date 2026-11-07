import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toOpportunityListItem } from "../../src/lib/opportunityPresentation.js";
import { DEFAULT_DISCOVERY_FILTERS, filterOpportunities } from "../../src/lib/opportunityDiscovery.js";

const opportunity = {
  id: "funding-call", opportunityType: "open-funding", organisation: "SMU",
  amount: 25000, currency: "USDT", status: "submitted", categories: [],
  expiresAt: new Date("2027-02-05T00:00:00Z"),
};

describe("open-funding discovery balances", () => {
  it("does not present or filter a legacy advertised budget as available contract funds", () => {
    const item = toOpportunityListItem(opportunity);
    assert.equal(item.amount, "View grant pool");
    assert.equal(item.amountValue, null);
    assert.equal(filterOpportunities([item], DEFAULT_DISCOVERY_FILTERS).length, 1);
    assert.equal(filterOpportunities([item], { ...DEFAULT_DISCOVERY_FILTERS, minimumFunding: "20000" }).length, 0);
    assert.equal(filterOpportunities([item], { ...DEFAULT_DISCOVERY_FILTERS, maximumFunding: "30000" }).length, 0);
  });

  it("preserves indicative budget display and filtering for business problems", () => {
    const item = toOpportunityListItem({ ...opportunity, opportunityType: "business-problem" });
    assert.equal(item.amount, "USDT 25,000");
    assert.equal(item.amountValue, 25000);
    assert.equal(filterOpportunities([item], { ...DEFAULT_DISCOVERY_FILTERS, minimumFunding: "20000" }).length, 1);
  });
});
