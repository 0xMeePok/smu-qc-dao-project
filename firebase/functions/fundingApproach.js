import { randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { independentListingWindowOpen, isIndependentProposal } from "./independentProposal.js";
import { instantMs } from "./opportunityExpiry.js";

export const FUNDING_APPROACHES = "fundingApproaches";
export const FUNDING_APPROACH_SLOTS = "fundingApproachSlots";
export const APPROACH_TEXT_MAX = 2000;

const CURRENCIES = new Set(["USDT", "USDC", "XSGD"]);
const BLOCKED = new Set(["hidden", "removed"]);
const fail = (code, message) => { throw new HttpsError(code, message); };
const same = (left, right) => String(left || "").toLowerCase() === String(right || "").toLowerCase();
const iso = (value) => value?.toDate?.().toISOString?.() ?? (value instanceof Date ? value.toISOString() : null);

function validId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail("invalid-argument", `Invalid ${name}.`);
}

function amountFor(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000_000) {
    fail("invalid-argument", "Enter an indicative amount greater than zero.");
  }
  return value;
}

function currencyFor(value) {
  if (!CURRENCIES.has(value)) fail("invalid-argument", "Choose a currency.");
  return value;
}

function textFor(value, label) {
  if (typeof value !== "string") fail("invalid-argument", `${label} is required.`);
  const text = value.trim();
  if (text.length < 2 || text.length > APPROACH_TEXT_MAX) {
    fail("invalid-argument", `${label} must be 2–${APPROACH_TEXT_MAX} characters.`);
  }
  return text;
}

export function fundingApproachSlotId(proposalId, funderId) {
  return `${proposalId}_${String(funderId || "").toLowerCase()}`;
}

function view(id, data) {
  return {
    id,
    funderId: data.funderId,
    proposalId: data.proposalId,
    researcherId: data.researcherId,
    amount: data.amount,
    currency: data.currency,
    scope: data.scope,
    message: data.message,
    status: data.status,
    expiresAt: iso(data.expiresAt),
    createdAt: iso(data.createdAt),
  };
}

/**
 * One pending indicative approach per funder per independent listing.
 * The slot document is the uniqueness lock; older approaches stay as their own records.
 * Clients cannot write either collection.
 */
export async function createFundingApproach({ db, uid, proposalId, amount, currency, scope, message, expiresAt, now = Timestamp.now() }) {
  validId(proposalId, "proposal");
  const funderId = String(uid || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(funderId)) fail("unauthenticated", "Sign in with your wallet.");
  amount = amountFor(amount);
  currency = currencyFor(currency);
  scope = textFor(scope, "Intended scope or conditions");
  message = textFor(message, "Message");
  const expiryMs = instantMs(expiresAt);
  if (!Number.isFinite(expiryMs)) fail("invalid-argument", "Choose when this approach expires.");

  const proposalRef = db.collection("proposals").doc(proposalId);
  const slotRef = db.collection(FUNDING_APPROACH_SLOTS).doc(fundingApproachSlotId(proposalId, funderId));
  const approachRef = db.collection(FUNDING_APPROACHES).doc(randomBytes(16).toString("hex"));

  return db.runTransaction(async (tx) => {
    const [profile, proposal, slot] = await Promise.all([
      tx.get(db.collection("users").doc(uid)),
      tx.get(proposalRef),
      tx.get(slotRef),
    ]);
    if (!profile.exists || profile.data().suspended) fail("permission-denied", "An active member profile is required.");
    if (profile.data().role !== 0) fail("permission-denied", "Only a client or funder can approach this listing with funding.");
    if (!proposal.exists) fail("not-found", "This proposal is no longer available.");
    const data = proposal.data();
    if (!isIndependentProposal(data)) fail("failed-precondition", "Only an independent listing can be approached this way.");
    if (!data.fundingTerms || typeof data.fundingTerms !== "object" || Array.isArray(data.fundingTerms)) {
      fail("failed-precondition", "This listing is not open for a funding approach.");
    }
    if (data.moderated || BLOCKED.has(data.moderationStatus)) fail("failed-precondition", "Funding is paused while this content is moderated.");
    if (same(data.researcherId, funderId)) fail("permission-denied", "The listing author cannot approach their own listing.");
    if (!independentListingWindowOpen(data, now.toDate())) fail("failed-precondition", "This listing's funding window is closed.");
    const listingMs = instantMs(data.expiresAt);
    const nowMs = now.toMillis();
    if (expiryMs <= nowMs) fail("invalid-argument", "Choose an expiry in the future.");
    if (!Number.isFinite(listingMs) || expiryMs > listingMs) {
      fail("invalid-argument", "The approach cannot stay open after the listing closes.");
    }
    const researcherId = String(data.researcherId || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(researcherId)) fail("failed-precondition", "This listing has no researcher to approach.");

    let previousRef = null;
    if (slot.exists && slot.data().approachId) {
      previousRef = db.collection(FUNDING_APPROACHES).doc(slot.data().approachId);
    }
    const previous = previousRef ? await tx.get(previousRef) : null;
    const previousData = previous?.exists ? previous.data() : null;
    const previousPending = previousData?.status === "pending" && instantMs(previousData.expiresAt) > nowMs;
    if (previousPending) fail("already-exists", "You already have a pending approach for this listing.");

    const record = {
      funderId,
      proposalId,
      researcherId,
      amount,
      currency,
      scope,
      message,
      status: "pending",
      expiresAt: Timestamp.fromMillis(expiryMs),
      createdAt: now,
      updatedAt: now,
    };
    if (previous?.exists && previousData.status === "pending") {
      tx.update(previousRef, { status: "expired", updatedAt: now });
    }
    tx.create(approachRef, record);
    tx.set(slotRef, {
      approachId: approachRef.id,
      funderId,
      proposalId,
      researcherId,
      status: "pending",
      updatedAt: now,
    });
    return view(approachRef.id, record);
  });
}
