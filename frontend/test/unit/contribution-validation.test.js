import assert from "node:assert/strict";
import { it } from "node:test";
import { contributionError, fundingTargetInputError } from "../../src/lib/contributionValidation.js";

const validate = (amount, extra = {}) => contributionError({ amount, decimals: 6, symbol: "USDT", remaining: 20_000_000n, balance: 50_000_000n, ...extra });
it("uses the remaining target and accepts its exact boundary without rounding", () => {
  assert.equal(validate("20"), "");
  assert.match(validate("19.999999"), /2 decimal places/);
  assert.equal(validate("20.000001"), "Only 20 USDT is still needed. Enter 20 USDT or less.");
  assert.equal(validate("100"), "Only 20 USDT is still needed. Enter 20 USDT or less.");
});
it("explains zero, negative, malformed and excessive-precision amounts", () => {
  for (const value of ["0", "0.000000", "-1"]) assert.match(validate(value), /greater than 0/);
  for (const value of ["1e2", "abc", "1,000"]) assert.match(validate(value), /valid positive amount/);
  assert.equal(validate("1.0000001"), "USDT supports at most 6 decimal places.");
  assert.equal(validate(""), "");
});
it("reports a full target and insufficient wallet funds separately", () => {
  assert.match(validate("1", { remaining: 0n }), /fully funded/);
  assert.equal(validate("20", { balance: 10_000_000n }), "Your USDT balance is too low. Available: 10 USDT.");
});
it("preserves exact base units for large balances and zero-decimal tokens", () => {
  const remaining = 9007199254740993000001n;
  assert.equal(validate("9007199254740993.000001", { remaining, balance: remaining }), "");
  assert.match(validate("9007199254740993.000002", { remaining, balance: remaining }), /9007199254740993\.000001 USDT/);
  assert.equal(validate("20", { decimals: 0, remaining: 20n, balance: 20n }), "");
  assert.match(validate("20.1", { decimals: 0, remaining: 20n }), /at most 0 decimal places/);
});

it("requires one token unless completing the balance, and prevents a dusty remainder", () => {
  assert.match(validate("0.99"), /at least 1/);
  assert.equal(validate("1"), "");
  assert.equal(validate("19"), "");
  assert.match(validate("19.01"), /leave|remaining/i);
  assert.equal(validate("0.99", { remaining: 990000n }), "");
  assert.equal(validate("0.000001", { remaining: 1n }), "");
  assert.match(validate("0.000001", { remaining: 2000000n }), /2 decimal places/);
});
it("validates new targets without rounding precision or imposing a minimum target", () => {
  assert.equal(fundingTargetInputError("1000.01", 6, "USDT"), "");
  assert.equal(fundingTargetInputError("0.01", 6, "USDT"), "");
  assert.match(fundingTargetInputError("1000.001", 6, "USDT"), /2 decimal places/);
  assert.match(fundingTargetInputError("0.000001", 6, "USDT"), /2 decimal places/);
});
