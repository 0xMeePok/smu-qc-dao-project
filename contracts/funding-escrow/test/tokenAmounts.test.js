import { expect } from "chai";
import { parseTokenAmount, formatTokenAmount, MAX_TOKEN_AMOUNT } from "../lib/tokenAmounts.js";

describe("Dashboard amount conversion: exact token base units", function () {
  for (const decimals of [0, 1, 2, 6, 8, 18, 24, 36, 77]) {
    it(`round-trips the smallest unit and uint256 maximum at ${decimals} decimals`, function () {
      for (const units of [1n, 10n, 1000n, 1000000000000000001n, MAX_TOKEN_AMOUNT]) {
        expect(parseTokenAmount(formatTokenAmount(units, decimals), decimals)).to.equal(units);
      }
      expect(formatTokenAmount(0n, decimals)).to.equal("0");
      const scale = 10n ** BigInt(decimals);
      expect(parseTokenAmount("1", decimals)).to.equal(scale);
      expect(formatTokenAmount(scale, decimals)).to.equal("1");
    });
  }

  it("uses the selected token's precision without losing fractional or large amounts", function () {
    expect(parseTokenAmount("1.25", 2)).to.equal(125n);
    expect(parseTokenAmount("1.25", 6)).to.equal(1250000n);
    expect(parseTokenAmount("1.25", 18)).to.equal(1250000000000000000n);
    expect(parseTokenAmount("9007199254740993.000001", 6)).to.equal(9007199254740993000001n);
    expect(formatTokenAmount(9007199254740993000001n, 6)).to.equal("9007199254740993.000001");
    expect(parseTokenAmount("0001.2500", 6)).to.equal(1250000n);
  });

  it("rejects excess precision, even if an extra fractional digit is zero", function () {
    for (const [input, decimals] of [["1.1", 0], ["1.0", 0], ["1.001", 2], ["0.0000001", 6], ["1.230", 2]]) {
      expect(() => parseTokenAmount(input, decimals)).to.throw("decimal precision");
    }
  });

  it("rejects zero, negative, floating-point and ambiguous textual input", function () {
    for (const input of ["0", "00.00", "-1", "+1", "1e6", "1,000", " 1", "1 ", "1\n", "1_000", "1.", ".5", "", "NaN", "Infinity", "1.2.3", "١", "0".repeat(161), 1.25, 1n, null, undefined]) {
      expect(() => parseTokenAmount(input, 6)).to.throw();
    }
  });

  it("rejects unsupported decimals instead of assuming six or eighteen", function () {
    for (const decimals of [-1, 78, 255, 1.5, NaN, Infinity, "6", 6n, null, undefined]) {
      expect(() => parseTokenAmount("1", decimals)).to.throw("decimals");
      expect(() => formatTokenAmount(1n, decimals)).to.throw("decimals");
    }
  });

  it("rejects uint256 overflow and invalid raw-unit formatting", function () {
    expect(() => parseTokenAmount((MAX_TOKEN_AMOUNT + 1n).toString(), 0)).to.throw("uint256");
    expect(() => parseTokenAmount("2", 77)).to.throw("uint256");
    for (const units of [-1n, MAX_TOKEN_AMOUNT + 1n, 1, "1", null]) {
      expect(() => formatTokenAmount(units, 6)).to.throw("uint256");
    }
  });
});
