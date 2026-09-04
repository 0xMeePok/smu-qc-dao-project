import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OPPORTUNITY_KIND } from "../../src/config/auditRegistry.js";
import { CURRENCIES } from "../../src/config/postingCategories.js";
import {
  fundingTagsFromCategories,
  MAX_FUNDING_TAGS,
  OPEN_FUNDING_TYPE,
  parseFundingTags,
} from "../../src/config/fundingOpportunity.js";
import {
  buildFundingOpportunityDocument,
  fundingOpportunityAuditPayload,
} from "../../src/lib/fundingOpportunities.js";
import { prepareFundingOpportunityAudit } from "../../src/lib/fundingOpportunityAudit.js";
import { toOpportunityListItem } from "../../src/lib/opportunityPresentation.js";
import {
  validateCurrency,
  validateFundingOpportunity,
  validateFundingTags,
} from "../../src/lib/validation.js";

const OWNER = `0x${"A".repeat(40)}`;

function completeForm(overrides = {}) {
  return {
    title: "Quantum-ready logistics research call",
    fundingThesis: "We will fund research that improves supply-chain resilience.",
    eligibilityNotes: "Universities and registered research organisations may apply.",
    categories: ["quantum", "optimisation"],
    amount: "250000",
    currency: "USDC",
    expiryDays: 90,
    ...overrides,
  };
}

describe("[QCDAO-51] open-funding form model", () => {
  it("normalises and de-duplicates comma-separated tags", () => {
    assert.deepEqual(
      parseFundingTags("  Logistics, climate   resilience, logistics, Quantum  "),
      ["Logistics", "climate resilience", "Quantum"],
    );
    assert.deepEqual(
      fundingTagsFromCategories(["ai", "quantum", "web3"]),
      ["AI & machine learning", "Quantum", "Web3 & blockchain"],
    );
  });

  it("validates every required field and bounds tags", () => {
    assert.deepEqual(validateFundingOpportunity(completeForm()), {});
    assert.deepEqual(CURRENCIES, ["USDT", "USDC", "XSGD"]);
    for (const currency of CURRENCIES) {
      assert.equal(validateCurrency(currency), null);
    }
    assert.match(validateCurrency("SGD"), /Choose a currency/);
    const errors = validateFundingOpportunity({
      title: "", fundingThesis: "", eligibilityNotes: "", categories: [],
      amount: "", currency: "", expiryDays: 0,
    });
    for (const field of [
      "title", "fundingThesis", "eligibilityNotes", "categories",
      "amount", "currency", "expiryDays",
    ]) assert.ok(errors[field], `${field} should have a field-level message`);

    assert.match(
      validateFundingTags(Array.from({ length: MAX_FUNDING_TAGS + 1 }, (_, i) => `tag${i}`).join(",")),
      /no more than/,
    );
    assert.match(validateFundingTags("x".repeat(41)), /40 characters/);
  });

  it("builds a distinct open-funding document without fixed-problem fields", () => {
    const record = buildFundingOpportunityDocument({
      ownerId: OWNER,
      organisation: " SMU ",
      form: completeForm(),
      now: new Date("2026-09-04T00:00:00Z"),
    });

    assert.equal(record.opportunityType, OPEN_FUNDING_TYPE);
    assert.equal(record.ownerId, OWNER.toLowerCase());
    assert.equal(record.organisation, "SMU");
    assert.equal(record.amount, 250000);
    assert.deepEqual(record.tags, ["Quantum", "Optimisation"]);
    for (const field of [
      "summary", "businessContext", "currentApproach", "currentLimitations",
      "expectedOutcome", "successCriteria", "dataAvailability", "attachments",
    ]) assert.equal(field in record, false, `${field} must not be stored`);
  });
});

describe("[QCDAO-51] AuditRegistry mapping", () => {
  it("anchors the canonical payload as OpportunityKind.OpenFunding", () => {
    const expiresAt = new Date("2026-12-03T00:00:00Z");
    const opportunity = {
      id: "funding-123",
      ...completeForm(),
      ownerId: OWNER,
      organisation: "SMU",
      amount: 250000,
      tags: ["Quantum", "Logistics"],
      expiresAt,
    };
    const payload = fundingOpportunityAuditPayload(opportunity);
    const setup = prepareFundingOpportunityAudit(opportunity);

    assert.equal(payload.opportunityType, OPEN_FUNDING_TYPE);
    assert.deepEqual(payload.categories, ["optimisation", "quantum"]);
    assert.deepEqual(payload.tags, ["Logistics", "Quantum"]);
    assert.equal(setup.prepared.functionName, "commitOpportunity");
    assert.equal(setup.prepared.args[1], OPPORTUNITY_KIND.OPEN_FUNDING);
    assert.equal(setup.prepared.args[3], BigInt(expiresAt.getTime() / 1000));
  });
});

describe("[QCDAO-51] shared discovery presentation", () => {
  it("labels open funding distinctly and keeps legacy postings as business problems", () => {
    const base = {
      id: "one",
      organisation: "SMU",
      currency: "USDT",
      amount: 250000,
      expiresAt: new Date("2026-12-03T00:00:00Z"),
    };
    assert.equal(toOpportunityListItem(base).type, "Business problem");
    assert.equal(toOpportunityListItem({ ...base, opportunityType: OPEN_FUNDING_TYPE }).type, "Open funding");
    assert.equal(toOpportunityListItem({ ...base, opportunityType: OPEN_FUNDING_TYPE }).route, "posting");
  });

  it("preserves metrics retrieved from related proposal and funding records", () => {
    const item = toOpportunityListItem({
      id: "one",
      organisation: "SMU",
      currency: "USDT",
      amount: 250000,
      proposalCount: 4,
      fundedAmount: 100000,
      fundingProgressPercent: 40,
      expiresAt: new Date("2026-12-03T00:00:00Z"),
    });
    assert.equal(item.proposalCount, 4);
    assert.equal(item.fundedAmount, 100000);
    assert.equal(item.fundingProgressPercent, 40);
  });
});
