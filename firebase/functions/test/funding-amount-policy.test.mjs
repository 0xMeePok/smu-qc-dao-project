import assert from "node:assert/strict";
import { canonicalizeAuditPayload, hashAuditPayload } from "../auditCanonical.js";
import { independentProposalAuditPayload } from "../proposalAuditPayload.js";
import { it } from "node:test";
import { fundingAmountError, fundingTargetError } from "../fundingAmountPolicy.js";
import { requireNewProposalTargetPolicy } from "../proposalPublicationPolicy.js";
import { escrowConfig } from "./fixtures/escrowAuditFixture.js";

const check = (amountBaseUnits, remainingBaseUnits = 1_000_000_000n, decimals = 6) =>
  fundingAmountError({ amountBaseUnits, remainingBaseUnits, decimals, symbol: "USDT" });
it("enforces cent precision, minimum contribution and no dust while allowing full completion", () => {
  assert.match(check(999_999_999n), /at most 2 decimal/);
  assert.match(check(999_990_000n), /leave only 0.01 USDT.*999 USDT or less.*1,?000 USDT/);
  assert.equal(check(999_000_000n), "");
  assert.equal(check(1_000_000_000n), "");
  assert.match(check(990_000n), /at least 1 USDT/);
  assert.equal(check(1_000_000n), "");
  assert.equal(check(500_000n, 500_000n), "");
  assert.match(check(1_000_000n, 1_500_000n), /exact remaining 1.5 USDT/);
});
it("keeps legacy off-cent remainders finishable without allowing arbitrary precision deposits", () => {
  assert.equal(check(765_433n, 765_433n), "");
  assert.match(check(755_433n, 765_433n), /at most 2 decimal/);
  assert.match(check(765_434n, 765_433n), /Only 0.765433/);
  assert.equal(check(1_765_433n, 1_765_433n), "");
  assert.match(check(1_000_000n, 1_765_433n), /exact remaining/);
});
it("handles zero, one and eighteen token decimals with integer arithmetic", () => {
  for (const decimals of [0, 1, 2, 6, 18]) {
    const token = 10n ** BigInt(decimals);
    assert.equal(check(token, 2n * token, decimals), "");
    assert.equal(check(2n * token, 2n * token, decimals), "");
    assert.match(check(3n * token, 2n * token, decimals), /Only 2/);
  }
  assert.equal(fundingTargetError({ targetBaseUnits: 10n ** 18n + 10n ** 16n, decimals: 18, symbol: "USDT" }), "");
  assert.match(fundingTargetError({ targetBaseUnits: 10n ** 18n + 1n, decimals: 18, symbol: "USDT" }), /at most 2 decimal/);
});
it("requires new publication cent targets but preserves corrections of unchanged historical targets", () => {
  const record = { amount: 1000.000001, currency: "USDC", status: "submitted" };
  const options = { registryConfig: escrowConfig };
  assert.throws(() => requireNewProposalTargetPolicy(record, options), /at most 2 decimal/);
  assert.throws(() => requireNewProposalTargetPolicy(record, { ...options, existingRecord: { ...record, status: "draft" } }), /at most 2 decimal/);
  assert.doesNotThrow(() => requireNewProposalTargetPolicy(record, { ...options, existingRecord: record }));
  assert.throws(() => requireNewProposalTargetPolicy({ ...record, amount: 1000.000002 }, { ...options, existingRecord: record }), /at most 2 decimal/);
  assert.doesNotThrow(() => requireNewProposalTargetPolicy({ ...record, amount: 1000.01 }, options));
});


it("preserves historical integer independent hashes and explicitly encodes newly supported cent targets", () => {
  const record = { researcherId: `0x${"a".repeat(40)}`, amount: 2, currency: "USDC", expiresAt: 1900000000,
    title: "Quantum routing", proposalKind: "independent" };
  const integer = independentProposalAuditPayload(record);
  assert.equal(hashAuditPayload("opportunity", integer, { hashScheme: 2 }),
    "0x34b6c51bc0d0468f15cb3ba142270184ff843f312b417b91f5b12d1867ff3ca5");
  assert.equal(integer.amount, 2);
  assert.equal(Object.hasOwn(integer, "amountEncoding"), false);
  // This was the exact historical representation: fractions could not have a valid hash.
  assert.throws(() => canonicalizeAuditPayload("opportunity", { ...integer, amount: 2.01 }, { hashScheme: 2 }), /safe integers/);
  const cents = independentProposalAuditPayload({ ...record, amount: 2.01 });
  assert.equal(cents.amount, "2.01");
  assert.equal(cents.amountEncoding, "decimal-v1");
  assert.doesNotThrow(() => hashAuditPayload("opportunity", cents, { hashScheme: 2 }));
  assert.equal(hashAuditPayload("opportunity", cents, { hashScheme: 2 }),
    hashAuditPayload("opportunity", independentProposalAuditPayload({ ...record, amount: "2.010" }), { hashScheme: 2 }));
  assert.throws(() => independentProposalAuditPayload({ ...record, amount: 2.001 }), /2 decimal/);
});
