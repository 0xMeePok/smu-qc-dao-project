import { evaluationExpiryAccepted, evaluationSlotId, EVALUATION_EXPIRY_MIGRATION } from "./evaluationExpiry.js";
import { PROPOSAL_LOCK_MIGRATION, readOpportunityProposalLockRepair } from "./opportunityProposalLocks.js";

// Deploy the synchronous write rules before starting either migration. New
// writes are then already normalized/locked, so a document-id cursor cannot
// miss a late insert. Markers fail closed until the final page commits.
export async function backfillSecurityStatePage({ db, now, kind, pageSize = 100 }) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new TypeError("Invalid page size.");
  if (!["evaluations", "proposal-locks"].includes(kind)) throw new TypeError("Invalid migration kind.");
  const evaluations = kind === "evaluations";
  const marker = db.collection("maintenanceState").doc(evaluations ? EVALUATION_EXPIRY_MIGRATION : PROPOSAL_LOCK_MIGRATION);
  const state = (await marker.get()).data() ?? {};
  if (state.ready === true) return { kind, done: true, scanned: 0 };
  let query = db.collection(evaluations ? "evaluations" : "proposals").orderBy("__name__").limit(pageSize);
  if (state.lastId) query = query.startAfter(state.lastId);
  const page = await query.get();
  let normalized = 0, occupiedSlots = 0;
  for (const row of page.docs) {
    await db.runTransaction(async tx => {
      const ref = db.collection(evaluations ? "evaluations" : "proposals").doc(row.id);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return;
      const record = snapshot.data();
      if (!evaluations) {
        const repair = await readOpportunityProposalLockRepair({ tx, db, recordId: row.id, storedRecord: record, now });
        repair();
        return;
      }
      let slotRef, slot;
      // Malformed legacy party ids still receive the exact expiry boolean;
      // they cannot authorize a new authenticated evaluation under the rules.
      try { slotRef = db.collection("evaluationSlots").doc(evaluationSlotId(record.proposalId, record.evaluatorId)); }
      catch { /* no valid wallet/proposal pair to reserve */ }
      if (slotRef) slot = await tx.get(slotRef);
      if (record.expiryAccepted !== evaluationExpiryAccepted(record)) {
        tx.update(ref, { expiryAccepted: evaluationExpiryAccepted(record) });
        normalized += 1;
      }
      if (slotRef && !slot.exists) {
        tx.set(slotRef, { proposalId: record.proposalId, evaluatorId: record.evaluatorId,
          evaluationId: row.id, createdAt: record.createdAt ?? now });
        occupiedSlots += 1;
      }
    });
  }
  const done = page.docs.length < pageSize;
  await marker.set({ ready: done, version: 1, lastId: done ? "" : page.docs.at(-1).id, updatedAt: now });
  return { kind, done, scanned: page.docs.length, normalized, occupiedSlots };
}
