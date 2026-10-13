import assert from "node:assert/strict";
import { test } from "node:test";
import { fundingAmount, fundingPercentage, fundingUnits, escrowLifecycle, confirmedFundingEvents } from "../../src/lib/fundingDisplay.js";

test("funding amounts and percentages preserve values beyond Number precision", () => {
  assert.equal(fundingAmount("900719925474099312345678", { tokenDecimals: 6, tokenSymbol: "USDC" }), "900719925474099312.345678 USDC");
  assert.deepEqual(fundingPercentage("300239975158033104115226", "900719925474099312345678"), { text: "33.33%", value: 33.33 });
  assert.equal(fundingPercentage("3", "2").text, "150%");
  assert.equal(fundingPercentage("3", "2").value, 100);
});

test("unknown or malformed units are never displayed as zero", () => {
  for (const value of [null, undefined, "", "-1", "1.0", "1e6", Number.MAX_SAFE_INTEGER + 1, 2n ** 256n]) assert.equal(fundingUnits(value), null);
  assert.equal(fundingPercentage("0", "0"), null);
  assert.equal(fundingAmount(null, { tokenDecimals: 6 }), "—");
  assert.equal(fundingAmount("0", { tokenDecimals: 6, tokenSymbol: "USDC" }), "0 USDC");
});

test("lifecycle labels follow verified contract states and keep pending transaction state separate", () => {
  const common = { verified: true };
  for (const [state, key] of [["Open", "pending"], ["Locked", "locked"], ["Active", "locked"], ["Released", "released"], ["Refunded", "refunded"], ["Cancelled", "cancelled"], ["Expired", "expired"], ["Voided", "invalidated"]]) {
    assert.equal(escrowLifecycle({ ...common, state, transactionStatus: "pending" }).key, key);
  }
  assert.equal(escrowLifecycle({ ...common, state: "Open", invalidated: true }).key, "invalidated");
  assert.equal(escrowLifecycle({ ...common, state: "Refunded", invalidated: true }).key, "refunded");
  assert.equal(escrowLifecycle({ ...common, state: "Released", workflowInvalidated: true }).key, "released");
  assert.equal(escrowLifecycle({ ...common, state: "Voided", invalidated: true, refundReason: "admin_cancelled" }).key, "cancelled");
  assert.equal(escrowLifecycle({ ...common, state: "Voided", lifecycle: { refundReason: "admin_cancelled" } }).key, "cancelled");
  assert.equal(escrowLifecycle({ ...common, state: "Open", cancellation: { status: "queued" }, refundReason: "admin_cancelled" }).key, "pending");
  assert.equal(escrowLifecycle({ ...common, state: "Refunded", invalidated: true, refundReason: "admin_cancelled" }).key, "refunded");
  assert.equal(escrowLifecycle({ ...common, workflow: "independent-crowdfunding", state: 1 }).key, "locked");
  assert.equal(escrowLifecycle({ state: "Released" }).key, "unverified");
  assert.equal(escrowLifecycle({ ...common, state: "Released" }, { stale: true }).key, "unverified");
});

test("state history excludes unconfirmed or malformed events and orders confirmed receipts", () => {
  const event = { verified: true, transactionHash: `0x${"a".repeat(64)}`, blockNumber: 100, timestamp: 1900000000 };
  const result = confirmedFundingEvents([{ ...event, id: "later", timestamp: 1900000001 }, { ...event, id: "first" },
    { ...event, id: "pending", verified: false }, { ...event, id: "bad_hash", transactionHash: "javascript:alert(1)" },
    { ...event, id: "bad_time", timestamp: NaN }, { ...event, id: "overflow_time", timestamp: Number.MAX_SAFE_INTEGER }]);
  assert.deepEqual(result.map(item => item.id), ["first", "later"]);
});
