import { FieldPath } from "firebase-admin/firestore";
import { EVIDENCE_COLLECTIONS, EVIDENCE_QUOTA_MIGRATION, evidenceDay, readEvidenceCharge } from "./evidenceQuotas.js";

function historicalDay(value, fallback) {
  try {
    const date = value?.toDate?.();
    if (date instanceof Date && Number.isFinite(date.getTime())) return date.toISOString().slice(0, 10);
  } catch { /* malformed legacy timestamp uses the migration day */ }
  return fallback;
}

/** Deploy closed client-create rules and drain old Functions before first use.
 * Scans actual collection groups, including orphaned/retired and malformed rows.
 * Charge records make interrupted pages replayable without modifying evidence.
 */
export async function backfillEvidenceQuotaPage({ db, now, pageSize = 100 }) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new TypeError("Invalid page size.");
  const marker = db.collection("maintenanceState").doc(EVIDENCE_QUOTA_MIGRATION);
  const state = (await marker.get()).data() ?? {};
  if (state.ready === true) {
    if (state.version !== 1) throw new Error("Unsupported evidence quota migration version.");
    return { done: true, scanned: 0 };
  }
  const phase = state.phase ?? 0, lastPath = state.lastPath ?? "";
  if (![0, 1].includes(phase)) throw new Error("Invalid evidence quota migration cursor.");
  let query = db.collectionGroup(EVIDENCE_COLLECTIONS[phase]).orderBy(FieldPath.documentId()).limit(pageSize);
  if (lastPath) {
    const split = lastPath.lastIndexOf("/");
    query = query.startAfter(db.collection(lastPath.slice(0, split)).doc(lastPath.slice(split + 1)));
  }
  const page = await query.get();
  let charged = 0;
  for (const row of page.docs) {
    await db.runTransaction(async tx => {
      const snapshot = await tx.get(row.ref);
      if (!snapshot.exists) return;
      const data = snapshot.data(), parts = row.ref.path.split("/");
      const proposalPath = parts.slice(0, -2).join("/");
      // The owner comes from the retained document, never the current parent.
      // Orphans have no parent and malformed owners still spend global/record
      // budgets through one explicit, non-authenticatable legacy owner bucket.
      const ownerBucket = /^0x[0-9a-f]{40}$/i.test(data.ownerId ?? "") ? data.ownerId.toLowerCase() : "legacy-invalid-owner";
      const charge = await readEvidenceCharge({ tx, db, path: row.ref.path, proposalPath, ownerBucket,
        day: historicalDay(data.createdAt, evidenceDay(now)), now, enforceLimits: false });
      if (charge()) charged += 1;
    });
  }
  const exhausted = page.docs.length < pageSize;
  const done = exhausted && phase === EVIDENCE_COLLECTIONS.length - 1;
  let advanced = false;
  await db.runTransaction(async tx => {
    const current = (await tx.get(marker)).data() ?? {};
    // Another bounded runner may already have advanced this cursor. Never
    // move it backwards or reopen a migration completed by that runner.
    if (current.ready === true || (current.phase ?? 0) !== phase || (current.lastPath ?? "") !== lastPath) return;
    tx.set(marker, { version: 1, ready: done, phase: exhausted ? Math.min(phase + 1, 1) : phase,
      lastPath: exhausted ? "" : page.docs.at(-1).ref.path, updatedAt: now });
    advanced = true;
  });
  return { done, scanned: page.docs.length, charged, advanced };
}
