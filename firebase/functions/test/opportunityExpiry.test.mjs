import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_EXPIRY_DAYS,
  EXPIRY_REASON_LABELS,
  EXPIRY_REASONS,
  EXPIRY_WINDOW_DAYS,
  MAX_EXPIRY_DAYS,
  MIN_EXPIRY_DAYS,
  countedFundingAmount,
  deadlinePassed,
  expiryFrom,
  expiryReason,
  expiryReasonFromFacts,
  extendExpiry,
  isExpiredOpenOpportunity,
  isResponseWindowClosed,
} from "../opportunityExpiry.js";

const NOW = new Date("2026-09-12T12:00:00Z");
const PAST = new Date("2026-09-12T11:59:59Z");
const FUTURE = new Date("2026-09-12T12:00:01Z");

function opportunity(overrides = {}) {
  return {
    status: "open",
    expiresAt: PAST,
    amount: 1000,
    ...overrides,
  };
}

function funding(amount = 1000, status = "pledged") {
  return { amount, status };
}

describe("opportunity expiry helpers", () => {
  it("exports stable expiry reasons and human-readable labels", () => {
    assert.deepEqual(EXPIRY_REASONS, {
      FUNDING_REQUIREMENT_NOT_MET: "funding_requirement_not_met",
      EVALUATION_NOT_COMPLETED: "evaluation_not_completed",
      NO_SOLUTION_SELECTED: "no_solution_selected",
    });
    assert.deepEqual(EXPIRY_REASON_LABELS, {
      funding_requirement_not_met: "Funding requirement not met",
      evaluation_not_completed: "Evaluation not completed",
      no_solution_selected: "No solution selected",
    });
  });

  it("counts only live funding statuses and ignores malformed amounts", () => {
    assert.equal(countedFundingAmount([
      funding(100, "pledged"),
      funding("200", "approved"),
      funding(300, "disbursing"),
      funding(400, "completed"),
      funding(500, "cancelled"),
      funding(-10, "pledged"),
      funding("not-a-number", "approved"),
    ]), 1000);
  });

  it("recognises only expired response-open opportunities", () => {
    assert.equal(isExpiredOpenOpportunity(opportunity({ status: "submitted" }), NOW), true);
    assert.equal(isExpiredOpenOpportunity(opportunity({ expiresAt: NOW }), NOW), true);
    assert.equal(isExpiredOpenOpportunity(opportunity({ expiresAt: FUTURE }), NOW), false);
    assert.equal(isExpiredOpenOpportunity(opportunity({ expiresAt: null }), NOW), false);
    assert.equal(isExpiredOpenOpportunity(opportunity({ expiresAt: "not-a-date" }), NOW), false);
    assert.equal(expiryReason({ opportunity: opportunity({ expiresAt: FUTURE }), now: NOW }), null);
  });

  it("does not apply expiry outcomes to terminal or non-open statuses", () => {
    for (const status of ["draft", "in_review", "matched", "funded", "completed", "cancelled", "expired"]) {
      const expired = opportunity({ status, expiresAt: PAST });
      assert.equal(isExpiredOpenOpportunity(expired, NOW), false, status);
      assert.equal(expiryReason({ opportunity: expired, now: NOW }), null, status);
    }
  });

  it("gives unmet funding the first precedence", () => {
    assert.equal(expiryReason({
      opportunity: opportunity(),
      funding: [funding(999)],
      proposals: [{ status: "submitted" }],
      evaluations: [{ status: "draft" }],
      now: NOW,
    }), EXPIRY_REASONS.FUNDING_REQUIREMENT_NOT_MET);
  });

  it("requires submitted or under-review proposals to finish evaluation after funding is met", () => {
    for (const status of ["submitted", "under_review"]) {
      assert.equal(expiryReason({
        opportunity: opportunity(),
        funding: [funding()],
        proposals: [{ status }],
        now: NOW,
      }), EXPIRY_REASONS.EVALUATION_NOT_COMPLETED, status);
    }
  });

  it("requires every evaluation record to be accepted after funding is met", () => {
    for (const status of ["draft", "submitted", "rejected", ""]) {
      assert.equal(expiryReason({
        opportunity: opportunity(),
        funding: [funding()],
        proposals: [{ status: "rejected" }],
        evaluations: [{ status }],
        now: NOW,
      }), EXPIRY_REASONS.EVALUATION_NOT_COMPLETED, status || "missing");
    }
  });

  it("reports no solution selected once funding and evaluation requirements are satisfied", () => {
    assert.equal(expiryReason({
      opportunity: opportunity(),
      funding: [funding()],
      proposals: [],
      evaluations: [],
      now: NOW,
    }), EXPIRY_REASONS.NO_SOLUTION_SELECTED);
  });

  it("has no reason once an expired open opportunity has a selected solution", () => {
    for (const selection of [
      { acceptedProposalId: "proposal-1" },
      { acceptedSolutionId: "solution-1" },
      { hasAcceptedSolution: true },
    ]) {
      assert.equal(expiryReason({
        opportunity: opportunity(selection),
        funding: [funding()],
        proposals: [{ status: "accepted" }],
        evaluations: [{ status: "accepted" }],
        now: NOW,
      }), null);
    }
  });

  it("does not mutate opportunity, related records, or the supplied clock", () => {
    const input = {
      opportunity: opportunity(),
      funding: [funding(600, "pledged"), funding(400, "approved")],
      proposals: [{ status: "rejected" }],
      evaluations: [{ status: "accepted" }],
      now: new Date(NOW),
    };
    const before = structuredClone(input);

    assert.equal(expiryReason(input), EXPIRY_REASONS.NO_SOLUTION_SELECTED);
    assert.deepEqual(input, before);
  });
});

describe("shared deadline helpers", () => {
  it("treats the exact deadline instant as passed, matching the contract and rules", () => {
    assert.equal(deadlinePassed(NOW, NOW), true);
    assert.equal(deadlinePassed(PAST, NOW), true);
    assert.equal(deadlinePassed(FUTURE, NOW), false);
    assert.equal(deadlinePassed({ toDate: () => PAST }, NOW), true);
    assert.equal(deadlinePassed(null, NOW), false);
    assert.equal(deadlinePassed("not-a-date", NOW), false);
  });

  it("derives whole-second deadlines and extends only by a documented window, exactly", () => {
    assert.deepEqual([...EXPIRY_WINDOW_DAYS], [30, 60, 90, 180]);
    assert.deepEqual([DEFAULT_EXPIRY_DAYS, MIN_EXPIRY_DAYS, MAX_EXPIRY_DAYS], [90, 30, 180]);
    assert.equal(expiryFrom(30, new Date("2026-09-01T10:00:00.512Z")).toISOString(), "2026-10-01T10:00:00.000Z");
    const deadline = new Date("2026-09-01T10:00:00.250Z");
    assert.equal(extendExpiry(deadline, 60).getTime() - deadline.getTime(), 60 * 24 * 60 * 60 * 1000);
    assert.equal(extendExpiry({ toDate: () => deadline }, 180).toISOString(), "2027-02-28T10:00:00.250Z");
    assert.equal(extendExpiry(deadline, 45), null);
    assert.equal(extendExpiry("not-a-date", 30), null);
  });

  it("separates a closed window from the owner lockout", () => {
    assert.equal(isResponseWindowClosed({ status: "in_review", expiresAt: PAST }, NOW), true);
    assert.equal(isExpiredOpenOpportunity({ status: "in_review", expiresAt: PAST }, NOW), false);
    assert.equal(isResponseWindowClosed({ status: "cancelled", expiresAt: FUTURE }, NOW), true);
    assert.equal(isResponseWindowClosed({ status: "expired", expiresAt: FUTURE }, NOW), true);
    assert.equal(isResponseWindowClosed({ status: "open", expiresAt: FUTURE }, NOW), false);
  });

  it("ranks reasons identically from summarised facts and from records", () => {
    const facts = (overrides) => expiryReasonFromFacts({ opportunity: opportunity(), now: NOW, ...overrides });
    assert.equal(facts({ fundedAmount: 999 }), EXPIRY_REASONS.FUNDING_REQUIREMENT_NOT_MET);
    assert.equal(facts({ fundedAmount: 1000, hasPendingProposal: true }), EXPIRY_REASONS.EVALUATION_NOT_COMPLETED);
    assert.equal(facts({ fundedAmount: 1000, hasUnacceptedEvaluation: true }), EXPIRY_REASONS.EVALUATION_NOT_COMPLETED);
    assert.equal(facts({ fundedAmount: 1000 }), EXPIRY_REASONS.NO_SOLUTION_SELECTED);
    assert.equal(facts({ fundedAmount: 1000, opportunity: opportunity({ acceptedProposalId: "p" }) }), null);
  });
});
