import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INDEPENDENT_PROPOSAL_FIELDS,
  INDEPENDENT_PROPOSAL_HASH_SCHEME,
  INDEPENDENT_PROPOSAL_KIND,
  independentListingWindowOpen,
  isIndependentProposal,
} from "../../src/config/proposal.js";
import { OPPORTUNITY_KIND } from "../../src/config/auditRegistry.js";
import { validateIndependentProposal } from "../../src/lib/proposalValidation.js";
import {
  buildIndependentProposalDocument,
  isIndependentProposal as exportedKindCheck,
  proposalAuthorRoute,
} from "../../src/lib/proposals.js";
import { isIndependentQueueRow, sortProposalRows } from "../../src/lib/proposalQueues.js";
import { prepareStoredProposal } from "../../../firebase/functions/proposalAuditPayload.js";
import { requireProposalPublicationFundingPolicy } from "../../../firebase/functions/proposalPublicationPolicy.js";

const RESEARCHER = `0x${"a".repeat(40)}`;
const future = new Date("2099-12-29T09:00:00.000Z");
const past = new Date("2020-01-01T00:00:00.000Z");

function completeForm(overrides = {}) {
  return {
    title: "I am an independent chad",
    summary: "A quantum-adjacent routing approach for independent discovery.",
    methodology: "Hybrid annealing with a classical fallback path.",
    addressedProblems: "Last-mile logistics under demand spikes.",
    team: "Two researchers with prior escrow deliveries.",
    category: "quantum-adjacent",
    maturity: "pilot",
    amount: "990",
    currency: "USDT",
    expiryDays: 90,
    ...overrides,
  };
}

function listing(overrides = {}) {
  return {
    id: "listing-1",
    researcherId: RESEARCHER,
    proposalKind: INDEPENDENT_PROPOSAL_KIND,
    status: "submitted",
    expiresAt: future,
    ...overrides,
  };
}

describe("independent listing proposals", () => {
  it("[FUT-RPF-183] stores an independent listing without a parent problemId", () => {
    const record = buildIndependentProposalDocument({
      researcherId: RESEARCHER,
      form: completeForm(),
      expiresAt: future,
    });
    assert.equal(exportedKindCheck(record), true);
    assert.equal(isIndependentProposal(record), true);
    assert.equal(record.proposalKind, INDEPENDENT_PROPOSAL_KIND);
    assert.equal(record.status, "submitted");
    assert.equal(record.currency, "USDT");
    assert.equal(record.maturity, "pilot");
    assert.ok(!("problemId" in record));
    assert.ok(!("postingOwnerId" in record));
    assert.ok(!("opportunityType" in record));
    const prepared = prepareStoredProposal({ ...record, id: "listing-1" });
    assert.equal(prepared.hashScheme, INDEPENDENT_PROPOSAL_HASH_SCHEME);
    assert.equal(prepared.args[1], OPPORTUNITY_KIND.FUNDING_REQUEST);
  });

  it("[FUT-RPF-184] requires every independent publish field before submit", () => {
    assert.deepEqual(validateIndependentProposal(completeForm()), {});
    const empty = validateIndependentProposal({});
    for (const [key] of INDEPENDENT_PROPOSAL_FIELDS) assert.ok(empty[key], `${key} should be required`);
    assert.ok(empty.category);
    assert.ok(empty.maturity);
    assert.ok(empty.amount);
    assert.ok(empty.currency);
    assert.ok(validateIndependentProposal(completeForm({ category: "unknown" })).category);
    assert.ok(validateIndependentProposal(completeForm({ maturity: "alpha" })).maturity);
    assert.ok(validateIndependentProposal(completeForm({ amount: "0" })).amount);
  });

  it("validates new independent targets while allowing legacy content corrections", () => {
    assert.match(validateIndependentProposal(completeForm({ amount: "1000.001" })).amount, /2 decimal places/);
    assert.equal(validateIndependentProposal(completeForm({ amount: "1000.01" })).amount, undefined);
    assert.equal(validateIndependentProposal(completeForm({ amount: "1000.001" }), { requireFundingPlan: false }).amount, undefined);
  });

  it("[FUT-RPF-185] skips frozen escrow validation on a content edit", () => {
    const incomplete = completeForm({
      immutableFundingTerms: { trancheBps: [5000, 5000] },
    });
    assert.ok(validateIndependentProposal(incomplete).fundingPlan);
    assert.equal(
      validateIndependentProposal(incomplete, { requireFundingPlan: false }).fundingPlan,
      undefined,
    );
    assert.deepEqual(validateIndependentProposal(incomplete, { requireFundingPlan: false }), {});
  });

  it("[FUT-RPF-186] copies stored escrow terms instead of rebuilding them", () => {
    const stored = { trancheBps: [5000, 5000], note: "not a canonical six-field map" };
    const edited = buildIndependentProposalDocument({
      researcherId: RESEARCHER,
      form: completeForm({
        immutableFundingTerms: stored,
        freezeFundingTerms: true,
        title: "Revised independent listing title",
      }),
      expiresAt: future,
    });
    assert.equal(edited.title, "Revised independent listing title");
    assert.equal(edited.fundingTerms, stored);
    const frozen = buildIndependentProposalDocument({
      researcherId: RESEARCHER,
      form: completeForm({ freezeFundingTerms: true }),
      expiresAt: future,
    });
    assert.ok(!("fundingTerms" in frozen));
    assert.ok(!("fundingPlan" in frozen));
  });

  it("[FUT-RPF-187] opens the listing window from its own expiresAt", () => {
    assert.equal(independentListingWindowOpen(listing()), true);
    assert.equal(independentListingWindowOpen(listing({ status: "under_review" })), true);
    assert.equal(independentListingWindowOpen(listing({ expiresAt: past })), false);
    assert.equal(independentListingWindowOpen(listing({ status: "withdrawn" })), false);
    assert.equal(independentListingWindowOpen({ status: "submitted", expiresAt: future }), false);
  });

  it("[FUT-RPF-188] lets an independent save proceed without canonical escrow terms", () => {
    const independent = listing({ fundingTerms: undefined });
    assert.doesNotThrow(() => requireProposalPublicationFundingPolicy(independent));
    assert.doesNotThrow(() => requireProposalPublicationFundingPolicy(
      listing({ fundingTerms: { trancheBps: [5000, 5000] } }),
    ));
    assert.throws(
      () => requireProposalPublicationFundingPolicy(
        listing({ fundingTerms: { trancheBps: [4000, 6000] } }),
      ),
      /50% upfront and 50% on completion/,
    );
    assert.throws(
      () => requireProposalPublicationFundingPolicy({ status: "submitted" }),
      /Escrow funding terms are required/,
    );
    assert.doesNotThrow(() => prepareStoredProposal(listing()));
  });

  it("[FUT-RPF-189] routes independent drafts apart from attached proposals", () => {
    assert.equal(isIndependentQueueRow({ proposalKind: "independent", problemId: null }), true);
    assert.equal(isIndependentQueueRow({ problemId: "problem-1" }), false);
    assert.equal(proposalAuthorRoute({ id: "draft-1", status: "draft", proposalKind: "independent" }), "create-proposal/draft-1");
    assert.equal(proposalAuthorRoute({ id: "draft-2", status: "draft", problemId: "problem-1" }), "edit-proposal/draft-2");
    assert.equal(proposalAuthorRoute(listing()), "proposal/listing-1");
    const ordered = sortProposalRows([
      { id: "later", proposalKind: "independent", expiresAt: "2026-12-01T00:00:00.000Z" },
      { id: "sooner", proposalKind: "independent", expiresAt: "2026-10-01T00:00:00.000Z" },
    ], "closing");
    assert.deepEqual(ordered.map((row) => row.id), ["sooner", "later"]);
  });
});
