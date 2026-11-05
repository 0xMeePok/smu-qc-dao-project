export const PROPOSAL_LOCKS = "opportunityProposalLocks";
export const PROPOSAL_LOCK_MIGRATION = "opportunityProposalLocksV1";
const PUBLISHED = new Set(["submitted", "under_review", "accepted", "rejected"]);

export function attachedPublishedProposal(record) {
  return Boolean(record?.problemId && record?.researcherId && record.proposalKind !== "independent"
    && (PUBLISHED.has(record.status)
      || (["withdrawn", "moderated_hidden", "moderated_removed"].includes(record.status) && record.audit?.transactionHash)));
}

/** Read before transaction writes; invoke the returned closure after all reads.
 * Only an existing, published child authorizes repair. An uncommitted request
 * must never freeze a parent's terms merely by requesting an attestation.
 */
export async function readOpportunityProposalLockRepair({ tx, db, scope = "proposals", recordId, storedRecord, now }) {
  if (scope !== "proposals" || !attachedPublishedProposal(storedRecord)) return () => {};
  const ref = db.collection(PROPOSAL_LOCKS).doc(storedRecord.problemId);
  const lock = await tx.get(ref);
  if (lock.exists) return () => {};
  return () => tx.set(ref, {
    proposalId: recordId,
    researcherId: storedRecord.researcherId,
    createdAt: storedRecord.createdAt ?? now,
  });
}
