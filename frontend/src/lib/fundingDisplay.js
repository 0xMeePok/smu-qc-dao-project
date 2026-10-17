import { formatUnits } from "viem";
import { MAIN_ESCROW_STATE, MAIN_ESCROW_STATES, INDEPENDENT_ESCROW_STATES, ESCROW_LIFECYCLE_DETAILS } from "../config/workflowStatus.js";

/** Amounts stay in token base units. Only the bounded percentage becomes a
 * Number for native progress; neither amounts nor share calculations do. */
export function fundingUnits(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  if (!["string", "number", "bigint"].includes(typeof value) || !/^\d{1,78}$/.test(String(value))) return null;
  try { const amount = BigInt(value); return amount < 2n ** 256n ? amount : null; } catch { return null; }
}

export function fundingToken(summary = {}) {
  return { decimals: summary.tokenDecimals ?? summary.decimals, symbol: summary.tokenSymbol ?? summary.symbol ?? "" };
}

export function fundingAmount(value, summary = {}) {
  const amount = fundingUnits(value), { decimals, symbol } = fundingToken(summary);
  if (amount === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 77) return "—";
  return `${formatUnits(amount, decimals)} ${symbol}`.trim();
}

export function fundingPercentage(numerator, denominator) {
  const amount = fundingUnits(numerator), total = fundingUnits(denominator);
  if (amount === null || total === null || total === 0n) return null;
  const hundredths = amount * 10000n / total;
  return { text: `${hundredths / 100n}${hundredths % 100n ? `.${String(hundredths % 100n).padStart(2, "0").replace(/0$/, "")}` : ""}%`,
    value: Number(hundredths > 10000n ? 10000n : hundredths) / 100 };
}

export function hasConfirmedFunding(summary = {}) {
  return summary.verified !== false && summary.available !== false && summary.stale !== true
    && (summary.verified === true || summary.available === true || summary.snapshotVerified === true
      || (fundingUnits(summary.blockNumber) !== null && fundingUnits(summary.timestamp) !== null));
}

export function escrowLifecycle(summary = {}, { stale = false } = {}) {
  if (stale || !hasConfirmedFunding(summary)) return { key: "unverified", label: "State unverified", meaning: "Refresh the escrow to verify its current state and balances." };
  const independent = summary.workflow === "independent-crowdfunding";
  const state = typeof summary.state === "number" ? (independent ? INDEPENDENT_ESCROW_STATES : MAIN_ESCROW_STATES)[summary.state] : summary.state;
  if ([MAIN_ESCROW_STATE.RELEASED, MAIN_ESCROW_STATE.REFUNDED].includes(state)) return ESCROW_LIFECYCLE_DETAILS[state];
  if (state === MAIN_ESCROW_STATE.VOIDED && (summary.refundReason ?? summary.lifecycle?.refundReason) === "admin_cancelled") return ESCROW_LIFECYCLE_DETAILS[MAIN_ESCROW_STATE.CANCELLED];
  if (summary.invalidated === true || summary.workflowInvalidated === true) return ESCROW_LIFECYCLE_DETAILS[MAIN_ESCROW_STATE.VOIDED];
  return ESCROW_LIFECYCLE_DETAILS[state] ?? { key: "unverified", label: "State unverified", meaning: "The current escrow state could not be verified." };
}

export const fundingExplorer = (type, value) => `https://sepolia.arbiscan.io/${type}/${value}`;
export const validFundingAddress = value => /^0x[0-9a-f]{40}$/i.test(value ?? "");
export const validFundingTransaction = value => /^0x[0-9a-f]{64}$/i.test(value ?? "");

export function confirmedFundingEvents(events = []) {
  return events.filter(event => event.verified === true && validFundingTransaction(event.transactionHash)
    && fundingUnits(event.blockNumber) !== null && Number.isSafeInteger(event.timestamp) && event.timestamp > 0 && event.timestamp <= 8_640_000_000_000)
    .slice().sort((a, b) => a.timestamp - b.timestamp || Number(a.blockNumber) - Number(b.blockNumber) || (a.logIndex ?? 0) - (b.logIndex ?? 0));
}

/**
 * "USDT 1,000" for a decimal amount entered or stored as text, matching how the
 * app shows requested and target amounts elsewhere. The digits are grouped as a
 * string, so the exact amount is never rounded through a float.
 */
export function formatFundingAmount(currency, value) {
  let text = String(value ?? "").trim();
  if (/^\d+(\.\d+)?e[+-]?\d+$/i.test(text)) text = Number(text).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return [currency, text].filter(Boolean).join(" ");
  const whole = match[1].replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return [currency, match[2] ? `${whole}.${match[2]}` : whole].filter(Boolean).join(" ");
}
