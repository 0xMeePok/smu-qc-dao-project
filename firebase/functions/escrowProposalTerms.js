import { keccak256, stringToHex } from "viem";
import { normalizeFundingTerms, requireAddress } from "./escrowAudit.js";

export function configuredFundingToken(config, currency) {
  const matches = (config.escrow?.tokens ?? []).filter(token => token.symbol === currency);
  if (matches.length !== 1) throw new Error(`Configure exactly one escrow token for ${currency}.`);
  const token = matches[0];
  requireAddress(token.address, "Configured token");
  if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 77) throw new Error("Configured token precision is invalid.");
  return token;
}

/** Restore stored numeric amounts to plain decimal form, including very small tokens. */
export function fundingAmountText(value) {
  const text = String(value);
  if (!text.includes("e")) return text;
  const [coefficient, exponent] = text.split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  return point <= 0 ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length ? digits + "0".repeat(point - digits.length)
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function fundingAmountUnits(value, decimals) {
  if (typeof value === "number" && (!Number.isFinite(value) || value <= 0 || value > 1_000_000_000)) {
    throw new TypeError("Requested funding amount is invalid.");
  }
  const text = typeof value === "number" ? fundingAmountText(value) : String(value ?? "").trim();
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77
      || text.length > 160 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text)) {
    throw new TypeError("Use a plain decimal funding amount.");
  }
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new TypeError(`This token supports at most ${decimals} decimal places.`);
  const result = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (result <= 0n || result >= 1n << 256n) throw new TypeError("Funding amount must fit positive uint256 base units.");
  return result;
}

export function serializeFundingTerms(terms) {
  const normalized = normalizeFundingTerms(terms);
  return { ...normalized, target: normalized.target.toString(), trancheBps: [...normalized.trancheBps],
    reviewWindows: [...normalized.reviewWindows], milestoneHashes: [...normalized.milestoneHashes] };
}

function milestoneHashesFor(text, count) {
  return Array.from({ length: count }, (_, index) => keccak256(stringToHex(JSON.stringify({
    scheme: "qcdao.escrow.milestone.v1", index, milestones: String(text ?? "").trim().normalize("NFC"),
  }))));
}

export function proposalFundingTerms({ form, currency, config }) {
  const token = configuredFundingToken(config, currency);
  const target = fundingAmountUnits(form.amount, token.decimals);
  // Existing proposal amount fields are Firestore numbers. Reject precision loss
  // rather than silently changing the amount between the form and verification.
  if (target !== fundingAmountUnits(Number(form.amount), token.decimals)) {
    throw new TypeError("This amount exceeds the proposal form's numeric precision. Use fewer significant digits.");
  }
  if (form.immutableFundingTerms) {
    const saved = normalizeFundingTerms(form.immutableFundingTerms);
    if (saved.target !== target || saved.token !== token.address.toLowerCase()) throw new Error("The escrow funding amount and token cannot change after proposal creation.");
    if (milestoneHashesFor(form.milestones, saved.trancheBps.length).some((hash, index) => hash !== saved.milestoneHashes[index])) {
      throw new Error("The escrow milestones cannot change after proposal creation.");
    }
    return serializeFundingTerms(saved);
  }
  const ratios = String(form.tranchePercentages ?? "100").split(",").map(value => value.trim());
  if (ratios.length < 1 || ratios.length > 5 || ratios.some(value => !/^\d{1,3}(\.\d{1,2})?$/.test(value))) {
    throw new TypeError("Enter one to five percentages, separated by commas, with at most two decimal places.");
  }
  const trancheBps = ratios.map(value => {
    const [whole, fraction = ""] = value.split(".");
    return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  });
  const windows = String(form.reviewDays ?? "7").split(",").map(value => value.trim());
  if (windows.some(value => !/^\d{1,3}$/.test(value)) || (windows.length !== 1 && windows.length !== ratios.length)) {
    throw new TypeError("Enter one review window for all payments, or one per payment, in whole days.");
  }
  const reviewWindows = (windows.length === 1 ? ratios.map(() => windows[0]) : windows).map(value => Number(value) * 86400);
  const milestoneHashes = milestoneHashesFor(form.milestones, ratios.length);
  return serializeFundingTerms({ token: token.address, target, trancheBps, reviewWindows, milestoneHashes,
    funderVoting: form.funderVoting ?? false });
}

export function validateStoredFundingTerms(record, config) {
  const terms = normalizeFundingTerms(record.fundingTerms);
  const token = configuredFundingToken(config, record.currency);
  if (terms.token !== token.address.toLowerCase() || terms.target !== fundingAmountUnits(record.amount, token.decimals)) {
    throw new Error("Mismatch detected: the escrow token or target differs from the proposal's currency and amount.");
  }
  if (milestoneHashesFor(record.milestones, terms.trancheBps.length).some((hash, index) => hash !== terms.milestoneHashes[index])) {
    throw new Error("Mismatch detected: the escrow milestones differ from the proposal's deliverables.");
  }
  return terms;
}
