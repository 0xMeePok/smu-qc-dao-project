// Exact conversions for funding inputs and dashboard values. Never accept floats.
export const MAX_TOKEN_DECIMALS = 77;
export const MAX_TOKEN_AMOUNT = (1n << 256n) - 1n;

function validateDecimals(decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
    throw new RangeError("Token decimals must be an integer between 0 and 77.");
  }
}

function validateUnits(units) {
  if (typeof units !== "bigint" || units < 0n || units > MAX_TOKEN_AMOUNT) {
    throw new RangeError("Token units must be a nonnegative uint256 bigint.");
  }
}

/** Convert a positive plain decimal input to token base units, without rounding. */
export function parseTokenAmount(input, decimals) {
  validateDecimals(decimals);
  if (typeof input !== "string" || input.length > 160 || input.trim() !== input || !/^\d+(?:\.\d+)?$/.test(input)) {
    throw new TypeError("Enter a plain decimal string without signs, separators or exponents.");
  }
  const [whole, fraction = ""] = input.split(".");
  if (fraction.length > decimals) throw new RangeError("Amount exceeds the token's decimal precision.");
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  validateUnits(units);
  if (units === 0n) throw new RangeError("Deposit amount must be greater than zero.");
  return units;
}

/** Format historical base units with the escrow's snapshotted decimals. */
export function formatTokenAmount(units, decimals) {
  validateDecimals(decimals);
  validateUnits(units);
  if (decimals === 0) return units.toString();
  const digits = units.toString().padStart(decimals + 1, "0");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return digits.slice(0, -decimals) + (fraction ? `.${fraction}` : "");
}
