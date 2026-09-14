import { HttpsError } from "firebase-functions/v2/https";

export const resourceKey = (scope, id) => `${scope}_${id}`;
// Record and attachment IDs may contain underscores, so underscore-joining the
// tuple is ambiguous (p_a/file and p/a_file produce the same document ID).
// Dots are excluded by both validators and therefore make this mapping injective.
export const uploadReservationKey = (scope, id, attachmentId) => `${scope}.${id}.${attachmentId}`;
export const uploadObjectPath = (scope, uid, id, attachmentId) => `${scope}/${uid}/${id}/${attachmentId}.pdf`;

export function matchesUploadReservation(data, { scope, id, uid, attachmentId, path }) {
  return data?.scope === scope
    && data.recordId === id
    && data.uid === uid
    && data.attachmentId === attachmentId
    && data.path === path;
}
export function validateResource(scope, id) {
  if (!["problems", "proposals"].includes(scope) || !/^[A-Za-z0-9_-]{1,64}$/.test(id ?? "")) {
    throw new HttpsError("invalid-argument", "Invalid record reference.");
  }
}

// Reservations never expire/reassign: deleting a draft must not let somebody
// else acquire its ID, attachment namespace, or previous audit registration.
export async function reserveRecord({ db, scope, id, uid, now }) {
  validateResource(scope, id);
  const ref = db.collection("recordReservations").doc(resourceKey(scope, id));
  const day = now.toDate().toISOString().slice(0, 10);
  return db.runTransaction(async (tx) => {
    const ownerRef = db.collection("creationQuotas").doc(`${uid}_${day}`);
    const globalRef = db.collection("creationQuotas").doc(`global_${day}`);
    const [reservation, owner, global, existing, maintenance] = await Promise.all([
      tx.get(ref), tx.get(ownerRef), tx.get(globalRef), tx.get(db.collection(scope).doc(id)),
      tx.get(db.collection("maintenanceState").doc("registryCutover")),
    ]);
    if (maintenance.data()?.active) throw new HttpsError("unavailable", "Registry maintenance is in progress.");
    if (reservation.data()?.retired) throw new HttpsError("failed-precondition", "This record was retired. Create a new record.");
    const existingOwner = existing.data()?.[scope === "problems" ? "ownerId" : "researcherId"];
    if ((existing.exists && existingOwner !== uid) || (reservation.exists && reservation.data().uid !== uid)) {
      throw new HttpsError("permission-denied", "This record belongs to another member.");
    }
    if (reservation.exists) return;
    const ownerCount = owner.data()?.count ?? 0;
    const globalCount = global.data()?.count ?? 0;
    if (ownerCount >= 30 || globalCount >= 300) {
      throw new HttpsError("resource-exhausted", "The daily creation limit has been reached. Try again tomorrow.");
    }
    tx.set(ownerRef, { count: ownerCount + 1, updatedAt: now });
    tx.set(globalRef, { count: globalCount + 1, updatedAt: now });
    tx.set(ref, { uid, scope, recordId: id, createdAt: now });
  });
}

export async function reserveUpload({ db, scope, id, uid, attachmentId, size, sha256, now, Timestamp }) {
  validateResource(scope, id);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(attachmentId ?? "") || !Number.isInteger(size)
      || size <= 0 || size > 10 * 1024 * 1024 || !/^0x[0-9a-f]{64}$/.test(sha256 ?? "")) {
    throw new HttpsError("invalid-argument", "Invalid PDF upload metadata.");
  }
  await reserveRecord({ db, scope, id, uid, now });
  const key = uploadReservationKey(scope, id, attachmentId);
  const path = uploadObjectPath(scope, uid, id, attachmentId);
  await db.runTransaction(async (tx) => {
    const ref = db.collection("uploadReservations").doc(key);
    const ownerRef = db.collection("uploadQuotas").doc(uid);
    const recordRef = db.collection("uploadQuotas").doc(resourceKey(scope, id));
    const globalRef = db.collection("uploadQuotas").doc("global");
    const [existing, owner, record, parent, global, recordReservation, maintenance] = await Promise.all([
      tx.get(ref), tx.get(ownerRef), tx.get(recordRef), tx.get(db.collection(scope).doc(id)), tx.get(globalRef),
      tx.get(db.collection("recordReservations").doc(resourceKey(scope, id))),
      tx.get(db.collection("maintenanceState").doc("registryCutover")),
    ]);
    if (maintenance.data()?.active || recordReservation.data()?.retired) throw new HttpsError("failed-precondition", "This registry is retired or undergoing maintenance.");
    if (existing.exists) throw new HttpsError("already-exists", "Choose the file again to start a fresh upload.");
    if (scope === "proposals" && parent.exists && parent.data().status !== "draft") {
      throw new HttpsError("failed-precondition", "Submitted proposal attachments are frozen.");
    }
    if (parent.data()?.attachments?.some((item) => item.id === attachmentId)) {
      throw new HttpsError("failed-precondition", "Use a new attachment reference when replacing a file.");
    }
    const ownerBytes = owner.data()?.bytes ?? 0;
    const recordBytes = record.data()?.bytes ?? 0;
    const recordCount = record.data()?.count ?? 0;
    if (ownerBytes + size > 500 * 1024 * 1024 || recordBytes + size > 100 * 1024 * 1024 || recordCount >= 10
        || (global.data()?.bytes ?? 0) + size > 5 * 1024 * 1024 * 1024) {
      throw new HttpsError("resource-exhausted", "Attachment storage quota reached. Remove unused draft files or contact an administrator.");
    }
    tx.set(globalRef, { bytes: (global.data()?.bytes ?? 0) + size });
    tx.set(ownerRef, { bytes: ownerBytes + size });
    tx.set(recordRef, { bytes: recordBytes + size, count: recordCount + 1 });
    tx.set(ref, { uid, scope, recordId: id, attachmentId, path, size, sha256,
      state: "reserved", sealed: false, quotaReleasedAt: null, createdAt: now,
      expiresAt: Timestamp.fromMillis(now.toMillis() + 60 * 60 * 1000) });
  });
  return { reservationId: key, path };
}

// Close the upload path before touching Storage. Keep its charge until deletion
// succeeds, so failed deletes cannot be used to reclaim quota around live bytes.
export async function retireUpload({ db, key, expectedPath, now }) {
  return db.runTransaction(async (tx) => {
    const ref = db.collection("uploadReservations").doc(key);
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return null;
    const data = snapshot.data();
    if (data.sealed) throw new HttpsError("failed-precondition", "Published attachment bytes must be retained.");
    if (!expectedPath || data.path !== expectedPath) {
      throw new HttpsError("failed-precondition", "The upload reservation does not match this object.");
    }
    if (data.state !== "retired") tx.update(ref, { state: "retired", retiredAt: now });
    return data.path;
  });
}

export async function releaseDeletedUpload({ db, key, deletedPath, now }) {
  return db.runTransaction(async (tx) => {
    const ref = db.collection("uploadReservations").doc(key);
    const snapshot = await tx.get(ref);
    const data = snapshot.data();
    if (!data || data.state !== "retired" || data.quotaReleasedAt || !data.size) return;
    if (!deletedPath || data.path !== deletedPath) {
      throw new HttpsError("failed-precondition", "Quota can be released only after deleting the reserved object.");
    }
    const ownerRef = db.collection("uploadQuotas").doc(data.uid);
    const recordRef = db.collection("uploadQuotas").doc(resourceKey(data.scope, data.recordId));
    const globalRef = db.collection("uploadQuotas").doc("global");
    const [owner, record, global] = await Promise.all([tx.get(ownerRef), tx.get(recordRef), tx.get(globalRef)]);
    tx.update(ref, { quotaReleasedAt: now });
    tx.set(globalRef, { bytes: Math.max(0, (global.data()?.bytes ?? 0) - data.size) });
    tx.set(ownerRef, { bytes: Math.max(0, (owner.data()?.bytes ?? 0) - data.size) });
    tx.set(recordRef, { bytes: Math.max(0, (record.data()?.bytes ?? 0) - data.size), count: Math.max(0, (record.data()?.count ?? 0) - 1) });
  });
}
