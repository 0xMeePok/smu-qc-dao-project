import { formatUnits } from "viem";
import { fundingAmountError, fundingTargetError } from "../../../firebase/functions/fundingAmountPolicy.js";
import { fundingAmountUnits } from "../../../firebase/functions/escrowProposalTerms.js";

export function remainingContributionMessage(remaining, decimals, symbol) {
  const maximum = `${formatUnits(BigInt(remaining), decimals)} ${symbol}`.trim();
  return BigInt(remaining) <= 0n ? "This proposal is fully funded. No further contributions are needed."
    : `Only ${maximum} is still needed. Enter ${maximum} or less.`;
}

/** Display validation only; every deposit still runs fresh preflight/contract checks. */
export function contributionError({ amount, decimals, symbol, remaining, balance }) {
  const text = String(amount ?? "").trim();
  if (!text) return "";
  let units;
  try { units = fundingAmountUnits(text, decimals); }
  catch {
    if (/^0+(\.0+)?$/.test(text) || /^-\d/.test(text)) return "Enter an amount greater than 0.";
    if (/^\d+\.\d+$/.test(text) && text.split(".")[1].length > decimals) {
      return `${symbol} supports at most ${decimals} decimal places.`;
    }
    return "Enter a valid positive amount using numbers and a decimal point.";
  }
  if (remaining !== undefined && remaining !== null && units > BigInt(remaining)) {
    return remainingContributionMessage(remaining, decimals, symbol);
  }
  const policyError = fundingAmountError({ amountBaseUnits: units, decimals, symbol, remainingBaseUnits: remaining });
  if (policyError) return policyError;
  if (balance !== undefined && balance !== null && units > BigInt(balance)) {
    return `Your ${symbol} balance is too low. Available: ${formatUnits(BigInt(balance), decimals)} ${symbol}.`;
  }
  return "";
}

/** New target validation only; stored funding terms retain their original precision. */
export function fundingTargetInputError(amount, decimals = 6, symbol = "") {
  try { return fundingTargetError({ targetBaseUnits: fundingAmountUnits(amount, decimals), decimals, symbol }); }
  catch { return `Enter a positive funding target with at most ${Math.min(2, decimals)} decimal places.`; }
}
