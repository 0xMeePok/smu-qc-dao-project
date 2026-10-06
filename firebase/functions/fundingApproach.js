import { randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { decodeEventLog } from "viem";
import { FUNDING_APPROACH_ANCHOR_ABI, fundingApproachAnchorId, fundingApproachRecordHash } from "./fundingApproachAnchor.js";
import { independentListingWindowOpen, isIndependentProposal } from "./independentProposal.js";
import { memberNoticeFields } from "./moderation.js";
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

const LIST_CAP = 50;

function listItem(id, data, extras) {
  return {
    id,
    proposalId: data.proposalId,
    proposalTitle: extras.proposalTitle || "Independent listing",
    funderId: data.funderId,
    funderName: extras.funderName || "",
    amount: data.amount ?? 0,
    currency: data.currency || "",
    scope: data.scope || "",
    message: data.message || "",
    status: data.status || "pending",
    expiresAt: iso(data.expiresAt),
    createdAt: iso(data.createdAt),
    approachAnchorId: data.anchor?.approachAnchorId ?? null,
    recordHash: data.anchor?.recordHash ?? null,
    anchorStatus: data.anchor?.status ?? null,
  };
}

async function lookup(db, collection, ids, pick) {
  const unique = [...new Set(ids.filter(Boolean))];
  const snaps = await Promise.all(unique.map((id) => db.collection(collection).doc(id).get()));
  return new Map(snaps.map((snap) => [snap.id, snap.exists ? pick(snap.data()) : ""]));
}

/** Incoming pending approaches for the researcher, and every approach this member sent. */
export async function listFundingApproaches({ db, uid, now = Timestamp.now() }) {
  const actorId = String(uid || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(actorId)) fail("unauthenticated", "Sign in with your wallet.");
  const profile = await db.collection("users").doc(uid).get();
  if (!profile.exists || profile.data().suspended) fail("permission-denied", "An active member profile is required.");
  const nowMs = now.toMillis();
  const [incomingPage, sentPage] = await Promise.all([
    db.collection(FUNDING_APPROACHES).where("researcherId", "==", actorId).where("status", "==", "pending")
      .orderBy("createdAt", "desc").limit(LIST_CAP + 1).get(),
    db.collection(FUNDING_APPROACHES).where("funderId", "==", actorId)
      .orderBy("createdAt", "desc").limit(LIST_CAP + 1).get(),
  ]);
  const incomingDocs = incomingPage.docs.filter((doc) => instantMs(doc.data().expiresAt) > nowMs).slice(0, LIST_CAP);
  const sentDocs = sentPage.docs.slice(0, LIST_CAP);
  const proposalIds = [...incomingDocs, ...sentDocs].map((doc) => doc.data().proposalId);
  const [titles, names] = await Promise.all([
    lookup(db, "proposals", proposalIds, (data) => data.title || "Independent listing"),
    lookup(db, "publicProfiles", incomingDocs.map((doc) => doc.data().funderId), (data) => data.fullName || data.organisation || ""),
  ]);
  const item = (doc) => listItem(doc.id, doc.data(), {
    proposalTitle: titles.get(doc.data().proposalId),
    funderName: names.get(doc.data().funderId),
  });
  return {
    incoming: incomingDocs.map(item),
    sent: sentDocs.map(item),
    truncated: { incoming: incomingPage.size > LIST_CAP, sent: sentPage.size > LIST_CAP },
  };
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
    approachAnchorId: data.anchor?.approachAnchorId ?? null,
    recordHash: data.anchor?.recordHash ?? null,
    anchorStatus: data.anchor?.status ?? null,
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
  const noticeRef = db.collection("moderationNotifications").doc(`funding_approach_${approachRef.id}`);
  const expiresAtIso = new Date(expiryMs).toISOString();
  const approachAnchorId = fundingApproachAnchorId(approachRef.id, funderId);

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
    const [previous, notice] = await Promise.all([
      previousRef ? tx.get(previousRef) : null,
      tx.get(noticeRef),
    ]);
    const previousData = previous?.exists ? previous.data() : null;
    const previousPending = previousData?.status === "pending" && instantMs(previousData.expiresAt) > nowMs;
    if (previousPending) fail("already-exists", "You already have a pending approach for this listing.");

    const recordHash = fundingApproachRecordHash({
      funderId, proposalId, researcherId, amount, currency, scope, message, expiresAt: expiresAtIso,
    });
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
      anchor: {
        status: "pending",
        eventVersion: 1,
        approachAnchorId,
        recordHash,
        transactionHash: null,
        anchoredAt: null,
        anchoredBy: null,
      },
    };
    if (previous?.exists && previousData.status === "pending") {
      tx.update(previousRef, { status: "expired", updatedAt: now });
    }
    tx.create(approachRef, record);
    if (!notice.exists) {
      const title = String(data.title || "Independent listing").slice(0, 160);
      const name = String(profile.data().fullName || profile.data().organisation || "A client or funder").slice(0, 80);
      tx.create(noticeRef, memberNoticeFields({
        recipientId: researcherId, now, createdAt: now, kind: "funding_approach",
        contentType: "proposal", contentId: proposalId, proposalId, title,
        message: `${name} approached your listing “${title}” with indicative funding of ${currency} ${amount}.`,
      }));
    }
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

/** Stores the funder's mined anchor once the registry log matches the saved digest. */
export async function saveFundingApproachAnchor({ db, client, config, uid, approachId, transactionHash, now = Timestamp.now() }) {
  validId(approachId, "approach");
  if (!/^0x[0-9a-f]{64}$/i.test(transactionHash || "")) fail("invalid-argument", "A transaction hash is required.");
  const funderId = String(uid || "").toLowerCase();
  const ref = db.collection(FUNDING_APPROACHES).doc(approachId);
  const snap = await ref.get();
  if (!snap.exists) fail("not-found", "This approach is no longer available.");
  const data = snap.data();
  if (!same(data.funderId, funderId)) fail("permission-denied", "Only the funder who sent this approach can anchor it.");
  const anchor = data.anchor || {};
  if (anchor.status === "confirmed" && same(anchor.transactionHash, transactionHash)) return view(approachId, data);
  if (!/^0x[0-9a-f]{64}$/i.test(anchor.approachAnchorId || "") || !/^0x[0-9a-f]{64}$/i.test(anchor.recordHash || "")) {
    fail("failed-precondition", "This approach has no anchor digest.");
  }
  const receipt = await client.getTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== "success") fail("failed-precondition", "The anchor transaction was not confirmed.");
  if (!same(receipt.from, funderId)) fail("permission-denied", "The anchor transaction was sent by a different wallet.");
  if (!same(receipt.to, config.address)) fail("failed-precondition", "The anchor was not sent to the audit registry.");
  let matched = null;
  for (const log of receipt.logs) {
    if (!same(log.address, config.address)) continue;
    try {
      const decoded = decodeEventLog({ abi: FUNDING_APPROACH_ANCHOR_ABI, topics: log.topics, data: log.data, strict: true });
      if (decoded.eventName === "FundingApproachAnchored") { matched = decoded.args; break; }
    } catch { /* The receipt can contain other registry logs. */ }
  }
  if (!matched) fail("failed-precondition", "The transaction does not anchor this approach.");
  if (!same(matched.approachId, anchor.approachAnchorId)) fail("failed-precondition", "The transaction anchors a different approach.");
  if (!same(matched.recordHash, anchor.recordHash)) fail("failed-precondition", "The anchored hash does not match this approach.");
  if (!same(matched.anchoredBy, funderId)) fail("permission-denied", "The anchor was not signed by this funder.");
  const confirmed = {
    ...anchor,
    status: "confirmed",
    transactionHash: transactionHash.toLowerCase(),
    blockNumber: Number(receipt.blockNumber),
    anchoredAt: new Date(Number(matched.anchoredAt) * 1000).toISOString(),
    anchoredBy: funderId,
  };
  await ref.update({ anchor: confirmed, updatedAt: now });
  return view(approachId, { ...data, anchor: confirmed });
}
