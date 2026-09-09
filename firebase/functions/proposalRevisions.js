import { prepareStoredProposal } from "./proposalAuditPayload.js";

// Frozen content list, mirroring the fields AuditRegistry hashes (see
// proposalAuditPayload.js) plus the attachments that make up the solution hash.
// An entry here and an on-chain revision therefore describe the same change.
// `audit`, `createdAt` and `updatedAt` are excluded: receipt delivery is
// bookkeeping, not an edit, and it writes far more often than a human does.
export const TRACKED_PROPOSAL_FIELDS = [
  "title", "summary", "methodology", "suitability", "expectedOutcomes",
  "successCriteria", "timeline", "milestones", "team",
  "proposedProblem", "relevance", "thesisFit",
  "category", "amount", "currency", "attachments",
];

/** Key order is not meaningful in Firestore maps, so sort before comparing. */
function canonical(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonical(value[key]);
      return out;
    }, {});
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function changedProposalFields(before = {}, after = {}) {
  return TRACKED_PROPOSAL_FIELDS.filter((key) => !same(before?.[key], after?.[key]));
}

/** Ties the entry to the on-chain revision. Never worth failing the trigger for. */
function contentHashOf(record, proposalId) {
  try {
    return prepareStoredProposal({ ...record, id: proposalId }).contentHash;
  } catch {
    return "";
  }
}

export function proposalRevisionEntry({ proposalId, before, after, at }) {
  const changedFields = changedProposalFields(before, after);
  const statusChanged = before.status !== after.status;
  if (!changedFields.length && !statusChanged) return null;

  const entry = {
    // firestore.rules lets only the author write a proposal's content or status,
    // so the stored researcherId IS the actor. A Firestore trigger carries no
    // auth context of its own, and inventing one would be a guess on the record.
    actor: after.researcherId ?? before.researcherId ?? "",
    researcherId: after.researcherId ?? before.researcherId ?? "",
    // Copied on so the sponsor can read the trail without a per-document lookup
    // in the rules. See the revisions match block in firestore.rules.
    postingOwnerId: after.postingOwnerId ?? before.postingOwnerId ?? "",
    changedFields,
    previousStatus: before.status ?? "",
    status: after.status ?? "",
    contentHashBefore: contentHashOf(before, proposalId),
    contentHashAfter: contentHashOf(after, proposalId),
    at,
  };
  if (statusChanged && after.status === "withdrawn") {
    entry.withdrawalReason = String(after.withdrawalReason ?? "").slice(0, 1000);
  }
  return entry;
}

export async function recordProposalRevision({ db, proposalId, eventId, before, after, at }) {
  // A create is the submission itself, already anchored as ProposalSubmitted; a
  // delete only ever removes an unsubmitted draft.
  if (!before || !after) return null;
  if (before.status === "draft") return null;

  const entry = proposalRevisionEntry({ proposalId, before, after, at });
  if (!entry) return null;

  // Keyed on the event id, not an auto id: Firestore retries a failed trigger,
  // and an append-only trail that double-counts one edit is misleading evidence.
  await db.collection("proposals").doc(proposalId)
    .collection("revisions").doc(eventId)
    .set(entry);
  return entry;
}
