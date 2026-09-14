import { createHash } from "node:crypto";
import { resourceKey } from "./resourceQuotas.js";

// Process roots and known child collections in separate bounded passes. The
// archive contains original Firestore values (including Timestamps/references).
export const RETIREMENT_COLLECTIONS = [
  "recordReservations", "uploadReservations", "problems", "proposals", "evaluations", "funding",
  "proposalAuditJobs", "publicationProofs", "opportunityMetrics", "metricContributions",
];
export const RETIREMENT_CHILDREN = ["revisions", "proposalAuthors"];
export const archiveRecordId = (path) => createHash("sha256").update(path).digest("hex");

export async function retireRegistryDocument({ db, sourceRef, registry, now }) {
  if (!/^0x[0-9a-f]{40}$/.test(registry)) throw new Error("Invalid retired registry address.");
  const archiveRef = db.collection("registryArchives").doc(registry).collection("records").doc(archiveRecordId(sourceRef.path));
  const [scope, id] = sourceRef.path.split("/");
  return db.runTransaction(async (tx) => {
    const [source, archive, maintenance] = await Promise.all([
      tx.get(sourceRef), tx.get(archiveRef), tx.get(db.collection("maintenanceState").doc("registryCutover")),
    ]);
    if (maintenance.data()?.active !== true || maintenance.data()?.registry !== registry) {
      throw new Error("Registry retirement requires active maintenance for this registry.");
    }
    if (!source.exists) return false;
    // A resumed pass must never overwrite the preserved original with a marker.
    if (archive.exists) {
      if (["recordReservations", "uploadReservations"].includes(scope) && source.data().retiredRegistry === registry) return false;
      throw new Error(`Source changed after archival: ${sourceRef.path}`);
    }
    const isRoot = sourceRef.path.split("/").length === 2;
    let reservationRef, reservation;
    if (isRoot && ["problems", "proposals"].includes(scope)) {
      reservationRef = db.collection("recordReservations").doc(resourceKey(scope, id));
      reservation = await tx.get(reservationRef);
    }
    tx.set(archiveRef, { sourcePath: sourceRef.path, data: source.data(), retiredAt: now });
    if (["recordReservations", "uploadReservations"].includes(scope)) {
      // Permanent tombstones prevent old tabs reusing a retired namespace. Keep
      // storage charges while archived bytes still occupy the bucket.
      tx.update(sourceRef, { retired: true, retiredRegistry: registry, retiredAt: now,
        ...(scope === "uploadReservations" ? { state: "retired", sealed: true } : {}) });
    } else {
      if (reservationRef) tx.set(reservationRef, { ...reservation.data(),
        uid: source.data()[scope === "problems" ? "ownerId" : "researcherId"] ?? "",
        scope, recordId: id, retired: true, retiredRegistry: registry, retiredAt: now });
      // The archive and removal commit together; interruption cannot delete a
      // record without its backup. Child documents are handled in later passes.
      tx.delete(sourceRef);
    }
    return true;
  });
}

// Delayed trigger deliveries must not recreate live subcollections after the
// cutover. Reading the tombstone in the write transaction also closes the race
// with the transaction that retires the parent.
export async function writeRegistryRevision({ db, scope, id, eventId, entry }) {
  const ref = db.collection(scope).doc(id).collection("revisions").doc(eventId);
  await db.runTransaction(async (tx) => {
    const reservation = await tx.get(db.collection("recordReservations").doc(resourceKey(scope, id)));
    const retired = reservation.data()?.retiredRegistry;
    if (retired) {
      const archived = db.collection("registryArchives").doc(retired).collection("records").doc(archiveRecordId(ref.path));
      if (!(await tx.get(archived)).exists) tx.set(archived, { sourcePath: ref.path, data: entry, retiredAt: entry.at });
    } else tx.set(ref, entry);
  });
}
