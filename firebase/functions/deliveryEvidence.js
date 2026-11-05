import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { keccak256, stringToHex } from "viem";
import { isAuthTimeRevoked, SESSION_REVOCATIONS_COLLECTION } from "./adminActions.js";
import { EVIDENCE_COLLECTIONS, EVIDENCE_QUOTA_MIGRATION, evidenceDay, readEvidenceCharge } from "./evidenceQuotas.js";

export function normalizeDeliveryEvidence(evidence) {
  const summary = String(evidence?.summary ?? "").trim().normalize("NFC");
  const url = String(evidence?.url ?? "").trim();
  let parsed;
  try { parsed = new URL(url); } catch { /* rejected below */ }
  if (summary.length < 2 || summary.length > 4000 || url.length > 2048
      || !url.startsWith("https://") || parsed?.protocol !== "https:" || !parsed.hostname) {
    throw new HttpsError("invalid-argument", "Describe the evidence in 2–4,000 characters and provide an HTTPS evidence link of at most 2,048 characters.");
  }
  return { summary, url };
}
export function hashDeliveryEvidence(evidence) {
  return keccak256(stringToHex(JSON.stringify({ scheme: "qcdao.escrow.delivery.v1", ...normalizeDeliveryEvidence(evidence) })));
}

/** Both stores retain their existing paths and immutable document schema. */
export async function persistDeliveryEvidence({ db, uid, authTime = 0, proposalId, evidence, evidenceHash,
  collection = "deliveryEvidence", now = Timestamp.now() }) {
  if (!/^0x[0-9a-f]{40}$/.test(uid ?? "")) throw new HttpsError("unauthenticated", "Sign in with your member wallet.");
  if (typeof proposalId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(proposalId) || !EVIDENCE_COLLECTIONS.includes(collection)
      || typeof evidenceHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(evidenceHash)) {
    throw new HttpsError("invalid-argument", "Invalid proposal evidence reference.");
  }
  const normalized = normalizeDeliveryEvidence(evidence), hash = hashDeliveryEvidence(normalized);
  // Main evidence previously passed the rules' HTTPS-without-whitespace gate.
  // Independent historical evidence used URL parsing alone; leave its hashing
  // and read normalization unchanged so old on-chain commitments remain readable.
  if (collection === "deliveryEvidence" && /\s/.test(normalized.url)) {
    throw new HttpsError("invalid-argument", "Provide an HTTPS evidence link without spaces or line breaks.");
  }
  if (hash !== evidenceHash.toLowerCase()) throw new HttpsError("invalid-argument", "The evidence differs from its delivery hash.");
  const proposalPath = `proposals/${proposalId}`, path = `${proposalPath}/${collection}/${hash}`;
  const ref = db.collection(`${proposalPath}/${collection}`).doc(hash);
  await db.runTransaction(async tx => {
    const [existing, parent, profile, cutoff, maintenance, reservation, migration] = await Promise.all([
      tx.get(ref), tx.get(db.collection("proposals").doc(proposalId)), tx.get(db.collection("users").doc(uid)),
      tx.get(db.collection(SESSION_REVOCATIONS_COLLECTION).doc(uid)),
      tx.get(db.collection("maintenanceState").doc("registryCutover")),
      tx.get(db.collection("recordReservations").doc(`proposals_${proposalId}`)),
      tx.get(db.collection("maintenanceState").doc(EVIDENCE_QUOTA_MIGRATION)),
    ]);
    if (!profile.exists || profile.data().suspended || isAuthTimeRevoked(authTime,
      profile.data().sessionsValidAfterEpoch, cutoff.data()?.sessionsValidAfterEpoch)) {
      throw new HttpsError("permission-denied", "Complete your active member profile and sign in again.");
    }
    if (maintenance.data()?.active || reservation.data()?.retired) {
      throw new HttpsError("failed-precondition", "This registry is retired or undergoing maintenance.");
    }
    const record = parent.data();
    if (!parent.exists || record.researcherId !== uid || typeof record.status !== "string" || record.status === "draft" || !("fundingTerms" in record)
        || (collection === "independentFundingEvidence" && record.proposalKind !== "independent")) {
      throw new HttpsError("permission-denied", "Only the active author of a published funding proposal can save delivery evidence.");
    }
    if (existing.exists) {
      const saved = existing.data();
      if (saved.ownerId !== uid || saved.summary !== normalized.summary || saved.url !== normalized.url) {
        throw new HttpsError("failed-precondition", "The saved delivery evidence differs from this hash.");
      }
      return; // Lost responses and retries are free, including during backfill.
    }
    if (migration.data()?.ready !== true || migration.data()?.version !== 1) {
      throw new HttpsError("unavailable", "Delivery evidence storage is being prepared. Retry shortly.");
    }
    const charge = await readEvidenceCharge({ tx, db, path, proposalPath, ownerBucket: uid,
      day: evidenceDay(now), now, enforceLimits: true });
    charge();
    tx.create(ref, { ...normalized, ownerId: uid, createdAt: now });
  });
  return { ...normalized, ownerId: uid };
}
