/** Policy for new proposal targets and wallet contributions, never accounting or refunds. */
function units(decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) throw new TypeError("Invalid token precision.");
  return { token: 10n ** BigInt(decimals), cent: 10n ** BigInt(Math.max(0, decimals - 2)) };
}

function display(value, decimals) {
  const text = value.toString().padStart(decimals + 1, "0");
  if (!decimals) return text;
  const fraction = text.slice(-decimals).replace(/0+$/, "");
  return text.slice(0, -decimals) + (fraction ? `.${fraction}` : "");
}

export function fundingTargetError({ targetBaseUnits, decimals, symbol }) {
  const target = BigInt(targetBaseUnits), { cent } = units(decimals);
  if (target <= 0n) return "Enter a funding target greater than 0.";
  if (target % cent !== 0n) return `Funding targets support at most 2 decimal places for ${symbol}.`;
  return "";
}

export function fundingAmountError({ amountBaseUnits, decimals, symbol, remainingBaseUnits }) {
  const amount = BigInt(amountBaseUnits), remaining = BigInt(remainingBaseUnits);
  const { token, cent } = units(decimals);
  if (amount <= 0n) return "Enter a contribution greater than zero.";
  if (remaining <= 0n) return "This proposal is fully funded. No further contributions are needed.";
  if (amount > remaining) return `Only ${display(remaining, decimals)} ${symbol} is still needed. Enter this amount or less.`;
  // Old escrows may already contain fractional-cent balances. Let the exact
  // verified remainder finish those escrows without rewriting their terms.
  if (amount === remaining && remaining % cent !== 0n) return "";
  if (amount % cent !== 0n) return `Contributions support at most 2 decimal places for ${symbol}.`;
  if (amount < token && amount !== remaining) return `Contribute at least 1 ${symbol}, or fund the exact remaining ${display(remaining, decimals)} ${symbol}.`;
  const remainder = remaining - amount;
  if (remainder > 0n && remainder < token) {
    const largestPartial = ((remaining - token) / cent) * cent;
    return `This contribution would leave only ${display(remainder, decimals)} ${symbol}. `
      + (largestPartial >= token ? `Enter ${display(largestPartial, decimals)} ${symbol} or less, or fund the remaining ${display(remaining, decimals)} ${symbol}.`
        : `Fund the exact remaining ${display(remaining, decimals)} ${symbol}.`);
  }
  return "";
}
