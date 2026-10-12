import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escrowCustodyLock, escrowFundingRequirementMet, escrowSelectionGate } from "../escrowCustody.js";

const open = changes => ({ state: "Open", fundingTarget: "100", totalDeposited: "100", totalReleased: "0",
  totalRefunded: "0", outstandingBalance: "100", custodyBalance: "100", timestamp: 1000,
  expiresAt: "2000", approvalDeadline: "3000", refundsEnabled: false, refundAvailableAt: "0",
  active: true, ...changes });

describe("QCDAO-111 confirmed escrow custody", () => {
  it("locks partial contributions until posting expiry and crosses the exact chain-time boundary", () => {
    const partial = open({ totalDeposited: "25", outstandingBalance: "25", custodyBalance: "25" });
    assert.deepEqual(escrowCustodyLock({ ...partial, timestamp: 1999 }), {
      status: "locked", unlockAt: "2000", reason: "posting_window", verifiedAt: "1999",
    });
    assert.equal(escrowCustodyLock({ ...partial, timestamp: 2000 }).status, "refundable");
    assert.equal(escrowSelectionGate(partial).fundingMet, false);
  });

  it("retains the posting lock for ordinary cancellation but preserves immediate authorized refunds", () => {
    const cancelled = open({ state: "Cancelled", refundsEnabled: true, refundAvailableAt: "2000" });
    assert.equal(escrowCustodyLock(cancelled).status, "locked");
    assert.equal(escrowCustodyLock({ ...cancelled, timestamp: 2000 }).status, "refundable");
    const rejected = { ...cancelled, refundAvailableAt: "1000" };
    assert.equal(escrowCustodyLock(rejected).status, "refundable");
    assert.equal(escrowCustodyLock({ ...rejected, state: "Voided" }).status, "refundable");
  });

  it("uses the full upfront deadline after selection and the completion deadline for unpaid work", () => {
    const upfront = open({ state: "Locked", timestamp: 2500 });
    assert.equal(escrowCustodyLock(upfront).unlockAt, "3000");
    assert.equal(escrowCustodyLock(upfront).status, "locked");
    assert.equal(escrowCustodyLock({ ...upfront, timestamp: 3000 }).status, "refundable");
    const active = open({ state: "Active", totalReleased: "50", outstandingBalance: "50", custodyBalance: "50" });
    assert.equal(escrowCustodyLock(active).reason, "completion");
    assert.equal(escrowSelectionGate(active).canSelect, false);
    const historical = open({ state: "Locked", timestamp: 1600, approvalDeadline: "1500",
      upfrontRefundUsesApprovalDeadline: false });
    assert.equal(escrowCustodyLock(historical).status, "locked");
    assert.equal(escrowCustodyLock(historical).unlockAt, "2000");
  });

  it("keeps independent acceptance and explicit decline refunds separate from the business handshake", () => {
    const independent = open({ workflow: "independent-crowdfunding", state: "Accepted",
      completionDeadline: "4000", totalReleased: "50", outstandingBalance: "50", custodyBalance: "50" });
    assert.equal(escrowCustodyLock(independent).unlockAt, "4000");
    assert.equal(escrowCustodyLock(independent).reason, "completion");
    assert.equal(escrowCustodyLock({ ...independent, state: "Declined" }).status, "refundable");
    assert.equal(escrowCustodyLock({ ...independent, state: "Cancelled", refundsEnabled: true }).status, "refundable");
  });

  it("distinguishes empty, paid and unverifiable custody without inventing an unlock date", () => {
    assert.equal(escrowCustodyLock(open({ totalDeposited: "0", outstandingBalance: "0" })).status, "empty");
    assert.equal(escrowCustodyLock(open({ state: "Released", totalReleased: "100", outstandingBalance: "0" })).status, "settled");
    for (const changes of [{ timestamp: undefined }, { expiresAt: undefined }, { expiresAt: "bad" },
      { state: "Unknown" }, { outstandingBalance: "-1" }, { totalDeposited: undefined },
      { state: "Cancelled", refundsEnabled: true, refundAvailableAt: undefined }]) {
      const lock = escrowCustodyLock(open(changes));
      assert.equal(lock.status, "unverified"); assert.equal(lock.unlockAt, null);
    }
  });

  it("requires recorded deposits and exact reconciled custody, excluding donations and missing metadata", () => {
    assert.equal(escrowFundingRequirementMet(open()), true);
    assert.equal(escrowFundingRequirementMet(open({ custodyBalance: "150" })), true);
    for (const changes of [
      { totalDeposited: "90", outstandingBalance: "90", custodyBalance: "150" },
      { custodyBalance: "99" }, { custodyBalance: undefined },
      { totalReleased: "50", outstandingBalance: "50", custodyBalance: "50" },
      { totalRefunded: "100", outstandingBalance: "0", custodyBalance: "0" },
      { totalReleased: "1" }, { fundingTarget: "0" }, { totalDeposited: "101" },
      { fundingTarget: Number.MAX_SAFE_INTEGER + 1 },
    ]) assert.equal(escrowFundingRequirementMet(open(changes)), false);
  });

  it("uses one shared selection predicate and keeps evaluator recommendations optional", () => {
    assert.deepEqual(escrowSelectionGate(open()), { fundingMet: true, feedbackRequired: false, canSelect: true });
    for (const changes of [{ state: "Locked" }, { active: false }, { timestamp: 2000 }, { custodyBalance: "99" }]) {
      assert.equal(escrowSelectionGate(open(changes)).canSelect, false);
    }
    assert.equal(escrowSelectionGate(open({ state: 0 })).canSelect, true);
  });
});
