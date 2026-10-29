import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPostingDocument, postingAuditPayload } from "../../src/lib/postings.js";
import { buildFundingOpportunityDocument, fundingOpportunityAuditPayload } from "../../src/lib/fundingOpportunities.js";
import { buildProposalDocument, buildIndependentProposalDocument } from "../../src/lib/proposals.js";
import { proposalAuditPayload, independentProposalAuditPayload } from "../../../firebase/functions/proposalAuditPayload.js";

const wallet = `0x${"a".repeat(40)}`;
const parent = { id: "ai-parent", ownerId: `0x${"b".repeat(40)}`, currency: "USDT" };
const form = {
  title: "Hybrid routing research", summary: "Research a routing baseline and test its robustness.",
  businessContext: "Delivery planning.", currentApproach: "A nightly classical solver.",
  currentLimitations: "Demand spikes defeat the current assumptions.", expectedOutcome: "A reproducible solver.",
  successCriteria: "Measured performance against a documented baseline.", dataAvailability: "Anonymised route telemetry.",
  fundingThesis: "Fund reproducible routing research.", eligibilityNotes: "Registered research teams.",
  methodology: "Benchmark a hybrid approach against the same classical baseline.", suitability: "Matches constrained routing.",
  expectedOutcomes: "A reproducible evaluation report.", timeline: "Discovery, benchmark, and review stages.",
  milestones: "Baseline; evaluation; report.", team: "Author-supplied team biography.",
  addressedProblems: "Routing and scheduling.", category: "hybrid", maturity: "concept",
  categories: ["quantum", "optimisation"], amount: "1000", currency: "USDT", expiryDays: 90,
};
const expiry = new Date("2099-01-01T00:00:00.000Z");
const builders = [
  ["problem", value => buildPostingDocument({ ownerId: wallet, organisation: "SMU", form: value, status: "draft", expiresAt: expiry }), postingAuditPayload],
  ["open funding", value => buildFundingOpportunityDocument({ ownerId: wallet, organisation: "SMU", form: value, status: "draft", expiresAt: expiry }), fundingOpportunityAuditPayload],
  ["proposal", value => buildProposalDocument({ researcherId: wallet, posting: parent, form: value, status: "draft" }), proposalAuditPayload],
  ["independent proposal", value => buildIndependentProposalDocument({ researcherId: wallet, form: value, status: "draft", expiresAt: expiry }), independentProposalAuditPayload],
];

describe("AI-assisted content metadata", () => {
  for (const [name, build, payload] of builders) {
    it(`persists accepted assistance on ${name} without storing a conversation or changing signed content`, () => {
      const ordinary = build(form);
      const assisted = build({ ...form, aiAssisted: true, messages: ["private conversation"], apiKey: "never persist" });
      assert.equal(assisted.aiAssisted, true);
      assert.equal(Object.hasOwn(ordinary, "aiAssisted"), false);
      assert.equal(Object.hasOwn(assisted, "messages"), false);
      assert.equal(Object.hasOwn(assisted, "apiKey"), false);
      assert.deepEqual(payload(assisted), payload(ordinary));
      for (const invalid of [false, "true", 1, null]) assert.equal(Object.hasOwn(build({ ...form, aiAssisted: invalid }), "aiAssisted"), false);
    });
  }
});
