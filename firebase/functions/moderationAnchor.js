import { keccak256, stringToHex } from "viem";

export const ANCHOR_JOBS = "escrowModerationAnchorJobs";

/** Same field order as the registry test. A different order would be a different digest. */
export function canonicalModerationRecord(record) {
  return JSON.stringify({
    eventVersion: 1,
    actorId: record.actorId,
    action: record.action,
    contentType: record.contentType,
    contentId: record.contentId,
    reason: record.reason,
    createdAt: record.createdAt,
    salt: record.salt,
  });
}

export function moderationDecisionId(eventId) {
  return keccak256(stringToHex(String(eventId)));
}

export function moderationRecordHash(record) {
  return keccak256(stringToHex(canonicalModerationRecord(record)));
}

/** Queue the digest in the same transaction as the decision so one event is anchored once. */
export function queueModerationAnchor(tx, db, { eventId, moderationId, recordHash, now }) {
  tx.set(db.collection(ANCHOR_JOBS).doc(eventId), {
    eventId, moderationId, recordHash, status: "pending",
    nextAttemptAt: now, createdAt: now, updatedAt: now,
  });
}
