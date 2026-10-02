import { httpsCallable } from "firebase/functions";
import { formatUnits } from "viem";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";

async function call(name, payload = {}) {
  requireFirebase();
  return (await httpsCallable(functions, name)(payload)).data;
}

export const prepareEscrowDeposit = payload => call("prepareEscrowDeposit", payload);
export const prepareRemovedProposalClaim = payload => call("prepareRemovedProposalClaim", payload);
export const syncEscrowFunding = payload => call("syncEscrowFunding", payload);
export const getEscrowFundingHistory = payload => call("getEscrowFundingHistory", payload);
export const getEscrowFundingSummary = () => call("getEscrowFundingSummary");
export const startEscrowSettlement = payload => call("startEscrowSettlement", payload);

export function escrowFundingAmount(amount, decimals, symbol = "") {
  if (amount == null || !Number.isInteger(decimals)) return "—";
  try { return `${formatUnits(BigInt(amount), decimals)} ${symbol}`.trim(); }
  catch { return "—"; }
}

export function escrowEventLabel(type) {
  return String(type ?? "Funding event").replace(/^escrow_/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
}

export const escrowExplorer = (type, value) => `https://sepolia.arbiscan.io/${type}/${value}`;
