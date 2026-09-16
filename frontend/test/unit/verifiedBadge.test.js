import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VERIFIED_BADGE_COPY,
  VERIFIED_BADGE_HINT,
  VERIFIED_STATES,
  verifiedStateFromAudit,
} from "../../src/config/verifiedBadge.js";

describe("Unit Tests: Trust indicator mapping (QCDAO-80)", () => {
  it("[FUT-BAV-136] should map stored audit receipts onto verified, pending, failed, and not anchored", () => {
    assert.equal(verifiedStateFromAudit({ status: "confirmed" }), VERIFIED_STATES.VERIFIED);
    assert.equal(verifiedStateFromAudit({ status: "queued" }), VERIFIED_STATES.PENDING);
    assert.equal(verifiedStateFromAudit({ status: "submitted" }), VERIFIED_STATES.PENDING);
    assert.equal(verifiedStateFromAudit({ status: "pending" }), VERIFIED_STATES.PENDING);
    assert.equal(verifiedStateFromAudit({ status: "failed" }), VERIFIED_STATES.FAILED);
    assert.equal(verifiedStateFromAudit({ status: "mismatch" }), VERIFIED_STATES.FAILED);
    assert.equal(verifiedStateFromAudit(null), VERIFIED_STATES.NOT_ANCHORED);
    assert.equal(verifiedStateFromAudit({}), VERIFIED_STATES.NOT_ANCHORED);
    assert.equal(verifiedStateFromAudit({ status: "waiting-wallet" }), VERIFIED_STATES.NOT_ANCHORED);
  });

  it("[FUT-BAV-137] should treat drafts as not anchored and keep workflow status off the verification chip", () => {
    assert.equal(
      verifiedStateFromAudit({ status: "confirmed" }, { recordStatus: "draft" }),
      VERIFIED_STATES.NOT_ANCHORED,
    );
    assert.equal(
      verifiedStateFromAudit(null, { recordStatus: "open" }),
      VERIFIED_STATES.NOT_ANCHORED,
    );
    assert.equal(
      verifiedStateFromAudit({ status: "confirmed" }, { recordStatus: "open" }),
      VERIFIED_STATES.VERIFIED,
    );
    assert.notEqual(VERIFIED_STATES.VERIFIED, "open");
    assert.notEqual(VERIFIED_STATES.PENDING, "submitted");
  });

  it("[FUT-BAV-138] should name every verification state in text and in a non-colour accessible label", () => {
    const states = Object.values(VERIFIED_STATES);
    assert.deepEqual(states, ["verified", "pending", "failed", "not-anchored"]);

    for (const state of states) {
      const copy = VERIFIED_BADGE_COPY[state];
      assert.ok(copy.label?.trim(), `Missing visible label for ${state}`);
      assert.ok(copy.ariaLabel?.trim(), `Missing aria-label for ${state}`);
      assert.match(copy.ariaLabel, /on-chain verification/i);
      assert.match(copy.ariaLabel, new RegExp(copy.label, "i"));
    }
  });

  it("[FUT-BAV-139] should explain in one sentence what is anchored on chain and what stays off-chain", () => {
    assert.match(VERIFIED_BADGE_HINT, /hash/i);
    assert.match(VERIFIED_BADGE_HINT, /timestamp/i);
    assert.match(VERIFIED_BADGE_HINT, /wallet/i);
    assert.match(VERIFIED_BADGE_HINT, /Arbitrum Sepolia/);
    assert.match(VERIFIED_BADGE_HINT, /record body/i);
    assert.match(VERIFIED_BADGE_HINT, /attachment/i);
    assert.match(VERIFIED_BADGE_HINT, /workflow/i);
    assert.match(VERIFIED_BADGE_HINT, /off-chain/i);
    assert.match(VERIFIED_BADGE_HINT, /Firestore/);
    assert.equal(VERIFIED_BADGE_HINT.includes("."), true);
    assert.ok(!VERIFIED_BADGE_HINT.includes("evaluation outcome"));
  });
});
