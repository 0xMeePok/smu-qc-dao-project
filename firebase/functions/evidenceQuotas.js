import { createHash } from "node:crypto";
import { HttpsError } from "firebase-functions/v2/https";

export const EVIDENCE_QUOTA_MIGRATION = "evidenceQuotasV1";
export const EVIDENCE_COLLECTIONS = Object.freeze(["deliveryEvidence", "independentFundingEvidence"]);
export const EVIDENCE_LIMITS = Object.freeze({ memberDaily: 30, globalDaily: 300,
  proposalLifetime: 100, memberLifetime: 1000, globalLifetime: 10000 });
export const evidenceChargeId = path => createHash("sha256").update(path).digest("hex");
export const evidenceDay = now => now.toDate().toISOString().slice(0, 10);
const bucketId = value => createHash("sha256").update(value).digest("hex");

// Hash the complete proposal path: even malformed legacy IDs and orphaned child
// documents are charged without ambiguous separators or invalid document IDs.
export function evidenceCounterKeys({ proposalPath, ownerBucket, day }) {
  return ["global", `member_${bucketId(ownerBucket)}`, `proposal_${bucketId(proposalPath)}`,
    `day_${day}_global`, `day_${day}_member_${bucketId(ownerBucket)}`];
}

/** Read first, then invoke the returned writer after ALL transaction reads. */
export async function readEvidenceCharge({ tx, db, path, proposalPath, ownerBucket, day, now, enforceLimits }) {
  const chargeRef = db.collection("evidenceCharges").doc(evidenceChargeId(path));
  const charge = await tx.get(chargeRef);
  if (charge.exists) {
    if (charge.data().sourcePath !== path) throw new HttpsError("failed-precondition", "The evidence charge does not match this document.");
    return () => false;
  }
  const keys = evidenceCounterKeys({ proposalPath, ownerBucket, day });
  const refs = keys.map(key => db.collection("evidenceQuotas").doc(key));
  const counters = await Promise.all(refs.map(ref => tx.get(ref)));
  const counts = counters.map(snapshot => snapshot.data()?.count ?? 0);
  if (counts.some(count => !Number.isSafeInteger(count) || count < 0)) {
    throw new HttpsError("failed-precondition", "Evidence quota accounting needs administrator repair.");
  }
  const limits = [EVIDENCE_LIMITS.globalLifetime, EVIDENCE_LIMITS.memberLifetime,
    EVIDENCE_LIMITS.proposalLifetime, EVIDENCE_LIMITS.globalDaily, EVIDENCE_LIMITS.memberDaily];
  if (enforceLimits && counts.some((count, index) => count >= limits[index])) {
    throw new HttpsError("resource-exhausted", "The delivery evidence limit has been reached. Retry the same evidence or contact an administrator.");
  }
  return () => {
    refs.forEach((ref, index) => tx.set(ref, { count: counts[index] + 1, updatedAt: now }));
    tx.create(chargeRef, { sourcePath: path, proposalPath, ownerBucket, day, createdAt: now });
    return true;
  };
}
