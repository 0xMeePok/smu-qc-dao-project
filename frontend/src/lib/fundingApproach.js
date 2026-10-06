import { httpsCallable } from "firebase/functions";
import { FUNDING_APPROACH_ANCHOR_ABI } from "../../../firebase/functions/fundingApproachAnchor.js";
import { AUDIT_REGISTRY_CHAIN_ID, getAuditRegistryAddress } from "../config/auditRegistry.js";
import { CURRENCIES } from "../config/postingCategories.js";
import { requireFirebase } from "./authFlow.js";
import { toDate } from "./datetime.js";
import { confirmEscrowTransaction, createWagmiEscrowAdapters, escrowErrorMessage } from "./escrow.js";
import { functions } from "./firebase.js";

export const APPROACH_TEXT_MAX = 2000;

function pad(number) {
  return String(number).padStart(2, "0");
}

/** Value for an `<input type="datetime-local">`, in the viewer's local time. */
export function dateTimeLocalValue(value) {
  const date = toDate(value);
  if (!date) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function emptyFundingApproach(proposal) {
  const currency = CURRENCIES.includes(proposal?.currency) ? proposal.currency : CURRENCIES[0];
  return {
    amount: "",
    currency,
    scope: "",
    message: "",
    expiresAt: dateTimeLocalValue(proposal?.expiresAt),
  };
}

function textError(value, label) {
  const text = String(value ?? "").trim();
  if (!text) return `${label} is required.`;
  if (text.length < 2) return `${label} needs to be more than one character.`;
  if (text.length > APPROACH_TEXT_MAX) return `${label} must be ${APPROACH_TEXT_MAX} characters or fewer.`;
  return null;
}

/**
 * Field errors for an indicative funding approach. An empty object means the
 * form can be sent. The expiry has to be later than `now` and no later than
 * the independent listing's own close.
 */
export function validateFundingApproach(form, { listingExpiresAt, now = new Date() } = {}) {
  const errors = {};
  const amount = Number(form?.amount);
  if (form?.amount === "" || form?.amount === null || form?.amount === undefined) {
    errors.amount = "Enter an indicative amount.";
  } else if (!Number.isFinite(amount)) {
    errors.amount = "Indicative amount must be a number.";
  } else if (amount <= 0) {
    errors.amount = "Indicative amount must be greater than zero.";
  } else if (amount > 1_000_000_000) {
    errors.amount = "Indicative amount is too large.";
  }

  if (!CURRENCIES.includes(form?.currency)) errors.currency = "Choose a currency.";

  const scope = textError(form?.scope, "Intended scope or conditions");
  if (scope) errors.scope = scope;
  const message = textError(form?.message, "Message");
  if (message) errors.message = message;

  const expiry = toDate(form?.expiresAt);
  const listingEnd = toDate(listingExpiresAt);
  if (!expiry) errors.expiresAt = "Choose when this approach expires.";
  else if (expiry.getTime() <= now.getTime()) errors.expiresAt = "Choose an expiry in the future.";
  else if (listingEnd && expiry.getTime() > listingEnd.getTime()) {
    errors.expiresAt = "The approach cannot stay open after the listing closes.";
  }

  return errors;
}

/** Normalised fields ready for the approach record. Validation must pass first. */
export function fundingApproachPayload(form) {
  return {
    amount: Number(form.amount),
    currency: form.currency,
    scope: String(form.scope).trim(),
    message: String(form.message).trim(),
    expiresAt: toDate(form.expiresAt).toISOString(),
  };
}

export function fundingApproachError(error, fallback = "This approach could not be sent. Please try again.") {
  const code = String(error?.code || "").split("/").pop();
  if (code === "unauthenticated") return "Sign in again to continue.";
  if (["invalid-argument", "permission-denied", "failed-precondition", "not-found", "already-exists"].includes(code)) {
    return error.message;
  }
  return fallback;
}

/** Server-owned pending record. The browser cannot write the collection itself. */
export async function createFundingApproach(proposalId, payload) {
  requireFirebase();
  return (await httpsCallable(functions, "createFundingApproach")({ proposalId, ...payload })).data;
}

export function fundingApproachStatusLabel(status) {
  if (status === "expired") return "Expired";
  if (status === "cancelled") return "Cancelled";
  return "Pending";
}

/** Incoming approaches for the signed-in researcher, and approaches they have sent. */
export async function listFundingApproaches() {
  requireFirebase();
  return (await httpsCallable(functions, "listFundingApproaches")({})).data;
}

/** The funder's wallet anchors the saved digest. The message is not sent to the chain. */
export async function submitFundingApproachAnchor(created, { account, adapters = createWagmiEscrowAdapters() } = {}) {
  if (!/^0x[0-9a-f]{64}$/i.test(created?.approachAnchorId || "") || !/^0x[0-9a-f]{64}$/i.test(created?.recordHash || "")) {
    throw new Error("This approach has no anchor digest.");
  }
  let transactionHash;
  try {
    transactionHash = await adapters.writeContract({
      address: getAuditRegistryAddress(),
      abi: FUNDING_APPROACH_ANCHOR_ABI,
      functionName: "anchorFundingApproach",
      args: [created.approachAnchorId, created.recordHash],
      account,
      chainId: AUDIT_REGISTRY_CHAIN_ID,
    });
    const receipt = await confirmEscrowTransaction(transactionHash, { adapters, confirmations: 2 });
    return { transactionHash: receipt.transactionHash ?? transactionHash };
  } catch (cause) {
    const error = new Error(escrowErrorMessage(cause));
    error.transactionHash = cause.transactionHash || transactionHash;
    throw error;
  }
}

export async function recordFundingApproachAnchor(approachId, transactionHash) {
  requireFirebase();
  return (await httpsCallable(functions, "recordFundingApproachAnchor")({ approachId, transactionHash })).data;
}
