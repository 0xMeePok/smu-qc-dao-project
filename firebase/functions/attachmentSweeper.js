import { Timestamp } from "firebase-admin/firestore";
import { matchesUploadReservation, retireUpload, releaseDeletedUpload,
  uploadReservationKey } from "./resourceQuotas.js";
/** Quota-backed, bounded cleanup of abandoned problem and proposal uploads.
 * Published evidence is sealed before publication and permanently retained.
 * Legacy published prefixes are also retained because revisions may reference
 * bytes that are no longer linked from the current document.
 */

export const ATTACHMENT_PREFIX = "problems/";

// An object younger than this is never touched, however unreferenced it looks.
// Uploads legitimately exist before their posting is saved - that is the whole
// point of remove-before-publish - so a freshly uploaded file on a form somebody
// is still filling in MUST survive. A day is far longer than any editing session.
export const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;

// A logic error here deletes user data, so no single run may delete more than this.
// Hitting the cap is itself the signal that something is wrong.
export const MAX_DELETES_PER_RUN = 500;

/**
 * Splits problems/{ownerId}/{problemId}/{attachmentId}.pdf into its parts.
 * Returns null for anything that is not exactly that shape - and null always means
 * "leave it alone", never "delete it".
 */
export function parseAttachmentPath(path) {
  if (typeof path !== "string") return null;
  const parts = path.split("/");
  if (parts.length !== 4) return null;

  const [prefix, ownerId, problemId, fileName] = parts;
  if (!["problems", "proposals"].includes(prefix)) return null;
  if (!/^0x[0-9a-f]{40}$/.test(ownerId)) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(problemId)) return null;
  if (!/^[A-Za-z0-9._-]{1,120}\.pdf$/.test(fileName)) return null;

  return { ownerId, problemId, attachmentId: fileName.replace(/\.pdf$/, ""), scope: prefix };
}

/**
 * Postings that have left draft. Objects under these ids stay in the bucket even
 * after the owner unlinks them: deleting an unreferenced published file would
 * let the owner recreate different bytes at the same {id}.pdf while the
 * opportunity hash (id/name/size/type) stayed unchanged.
 */
export function collectImmutableProblemIds(postings) {
  const published = new Set();
  for (const posting of postings) {
    if (!posting?.id) continue;
    if (posting.status && posting.status !== "draft") published.add(String(posting.id));
  }
  return published;
}

/**
 * The set of storage paths that postings actually point at. Anything in the bucket
 * and not in this set is unreferenced.
 */
export function collectReferencedPaths(postings) {
  const referenced = new Set();
  for (const posting of postings) {
    const attachments = Array.isArray(posting?.attachments) ? posting.attachments : [];
    const ownerId = String(posting?.ownerId ?? posting?.researcherId ?? "").toLowerCase();
    const problemId = posting?.id;
    for (const attachment of attachments) {
      // Legacy records carried `path`; current ones do not, so the path is rebuilt
      // exactly as attachmentPath() builds it in frontend/src/lib/attachments.js.
      // Reading only `path` made every live attachment look orphaned.
      if (typeof attachment?.path === "string") referenced.add(attachment.path);
      if (ownerId && problemId && attachment?.id) {
        referenced.add(`${posting.scope || (posting.researcherId ? "proposals" : "problems")}/${ownerId}/${problemId}/${attachment.id}.pdf`);
      }
    }
  }
  return referenced;
}

/**
 * Decides the fate of every object, without deleting anything.
 *
 * `objects` is [{ path, createdAt }] where createdAt is epoch milliseconds.
 * Returns { deletions, kept, skipped, capped } - `skipped` carries a reason per
 * object so a surprising run can be explained from the logs alone.
 */
export function planSweep({
  objects,
  referencedPaths,
  immutableProblemIds = new Set(),
  now,
  graceMs = DEFAULT_GRACE_MS,
  maxDeletes = MAX_DELETES_PER_RUN,
}) {
  const deletions = [];
  const skipped = [];
  let kept = 0;

  for (const object of objects) {
    const parsed = parseAttachmentPath(object.path);
    if (!parsed) {
      // Unrecognised shape. Something wrote a path this code does not understand,
      // and guessing about unknown data is how a sweeper destroys a bucket.
      skipped.push({ path: object.path, reason: "unrecognised-path" });
      continue;
    }

    if (referencedPaths.has(object.path)) {
      kept += 1;
      continue;
    }

    if (immutableProblemIds.has(parsed.problemId)) {
      skipped.push({ path: object.path, reason: "published-posting" });
      continue;
    }

    if (!Number.isFinite(object.createdAt)) {
      skipped.push({ path: object.path, reason: "unknown-age" });
      continue;
    }

    if (now - object.createdAt < graceMs) {
      skipped.push({ path: object.path, reason: "within-grace-period" });
      continue;
    }

    deletions.push(object.path);
  }

  // Truncate rather than refuse: a genuine backlog still gets cleared, one run at
  // a time, while a runaway plan cannot empty the bucket in a single pass.
  const capped = deletions.length > maxDeletes;
  return {
    deletions: capped ? deletions.slice(0, maxDeletes) : deletions,
    kept,
    skipped,
    capped,
  };
}

/**
 * Re-reads problems/{problemId} so a posting published after the collection
 * snapshot cannot have its attachment deleted in this run. A published record
 * retains every object under its prefix, referenced or not: unlinking then
 * sweeping is the other half of the byte-swap that storage.rules now refuse.
 */
async function mustRetainObject(db, path) {
  const parsed = parseAttachmentPath(path);
  if (!parsed) return true;
  const { scope, problemId, attachmentId } = parsed;
  const key = uploadReservationKey(scope, problemId, attachmentId);
  const [parent, reservation, proof, recordReservation] = await Promise.all([
    db.collection(scope).doc(problemId).get(),
    db.collection("uploadReservations").doc(key).get(),
    db.collection("publicationProofs").doc(`${scope}_${problemId}`).get(),
    db.collection("recordReservations").doc(`${scope}_${problemId}`).get(),
  ]);
  if (reservation.exists && !matchesUploadReservation(reservation.data(), {
    scope, id: problemId, uid: parsed.ownerId, attachmentId, path,
  })) return true;
  if (reservation.data()?.sealed || recordReservation.data()?.retired) return true;
  if (collectReferencedPaths([{ ...parent.data(), id: problemId, scope },
    { ...proof.data()?.record, id: problemId, scope }]).has(path)) return true;
  // Historical revisions may reference legacy objects. Keep their bytes; new
  // reservations distinguish unused uploads from immutable published files.
  return !reservation.exists && parent.exists && parent.data().status !== "draft";
}

/** Bounded, resumable scan over BOTH namespaces. No whole-collection queries. */
export async function sweepOrphanedAttachments({
  db, bucket, dryRun = true, now = Date.now(), graceMs = DEFAULT_GRACE_MS, logger = console,
}) {
  const summary = { scanned: 0, referenced: 0, orphans: 0, deleted: 0, skipped: 0, capped: false, dryRun };
  if ((await db.collection("maintenanceState").doc("registryCutover").get()).data()?.active) return { ...summary, maintenance: true };
  const reservationCheckpoint = db.collection("maintenanceState").doc("attachmentSweep_reservations");
  const previousReservations = (await reservationCheckpoint.get()).data();
  let abandonedQuery = db.collection("uploadReservations").where("state", "==", "reserved")
    .where("expiresAt", "<", Timestamp.fromMillis(now - graceMs))
    .orderBy("expiresAt").orderBy("__name__")
    .limit(250);
  if (previousReservations?.lastId) abandonedQuery = abandonedQuery.startAfter(previousReservations.expiresAt, previousReservations.lastId);
  const abandoned = await abandonedQuery.get();
  for (const reservation of abandoned.docs) {
    const data = reservation.data();
    if (data.sealed || typeof data.path !== "string") continue;
    const [exists] = await bucket.file(data.path).exists();
    if (!exists && !dryRun) {
      await retireUpload({ db, key: reservation.id, expectedPath: data.path, now: Timestamp.fromMillis(now) });
      await releaseDeletedUpload({ db, key: reservation.id, deletedPath: data.path, now: Timestamp.fromMillis(now) });
    }
  }
  if (!dryRun) {
    const last = abandoned.docs.at(-1);
    await reservationCheckpoint.set(last && abandoned.docs.length === 250
      ? { lastId: last.id, expiresAt: last.data().expiresAt } : { lastId: "" });
  }
  const retiredCheckpoint = db.collection("maintenanceState").doc("attachmentSweep_retired");
  const previousRetired = (await retiredCheckpoint.get()).data();
  let retiredQuery = db.collection("uploadReservations").where("state", "==", "retired")
    .where("quotaReleasedAt", "==", null).orderBy("__name__").limit(250);
  if (previousRetired?.lastId) retiredQuery = retiredQuery.startAfter(previousRetired.lastId);
  const retired = await retiredQuery.get();
  for (const reservation of retired.docs) {
    const path = reservation.data().path;
    if (typeof path !== "string") continue;
    const [exists] = await bucket.file(path).exists();
    if (!exists && !dryRun) await releaseDeletedUpload({ db, key: reservation.id,
      deletedPath: path, now: Timestamp.fromMillis(now) });
  }
  if (!dryRun) await retiredCheckpoint.set({ lastId: retired.docs.length === 250 ? retired.docs.at(-1).id : "" });
  for (const scope of ["problems", "proposals"]) {
    const checkpoint = db.collection("maintenanceState").doc(`attachmentSweep_${scope}`);
    const saved = await checkpoint.get();
    const [files, next] = await bucket.getFiles({ prefix: `${scope}/`, autoPaginate: false,
      maxResults: 250, ...(saved.data()?.pageToken ? { pageToken: saved.data().pageToken } : {}) });
    for (const file of files) {
      summary.scanned += 1;
      const parsed = parseAttachmentPath(file.name);
      const createdAt = Date.parse(file.metadata?.timeCreated ?? "");
      if (!parsed || !Number.isFinite(createdAt) || now - createdAt < graceMs) { summary.skipped += 1; continue; }
      if (await mustRetainObject(db, file.name)) { summary.referenced += 1; continue; }
      summary.orphans += 1;
      if (dryRun) continue;
      try {
        const key = uploadReservationKey(parsed.scope, parsed.problemId, parsed.attachmentId);
        const reservation = await db.collection("uploadReservations").doc(key).get();
        if (reservation.exists) {
          if (!matchesUploadReservation(reservation.data(), {
            scope: parsed.scope, id: parsed.problemId, uid: parsed.ownerId,
            attachmentId: parsed.attachmentId, path: file.name,
          })) throw new Error("Upload reservation does not match this object; retaining it.");
          await retireUpload({ db, key, expectedPath: file.name, now: Timestamp.fromMillis(now) });
        } else {
          // A legacy orphan gets a tombstone before deletion, closing future
          // reservation/recreation of the same path. Race against publication.
          await db.runTransaction(async (tx) => {
            const ref = db.collection("uploadReservations").doc(key);
            const proofRef = db.collection("publicationProofs").doc(`${parsed.scope}_${parsed.problemId}`);
            const [fresh, proof] = await Promise.all([tx.get(ref), tx.get(proofRef)]);
            if (fresh.exists || collectReferencedPaths([{ ...proof.data()?.record, id: parsed.problemId, scope: parsed.scope }]).has(file.name)) {
              throw new Error("Attachment changed during cleanup; retry next sweep.");
            }
            tx.set(ref, { state: "retired", uid: parsed.ownerId, scope: parsed.scope,
              recordId: parsed.problemId, attachmentId: parsed.attachmentId,
              path: file.name, retiredAt: Timestamp.fromMillis(now) });
          });
        }
        if (await mustRetainObject(db, file.name)) continue;
        if ((await db.collection("maintenanceState").doc("registryCutover").get()).data()?.active) continue;
        await file.delete({ ignoreNotFound: true, ifGenerationMatch: file.metadata?.generation });
        await releaseDeletedUpload({ db, key, deletedPath: file.name, now: Timestamp.fromMillis(now) });
        summary.deleted += 1;
      } catch (error) { logger.warn(`[attachment-sweep] retained ${file.name}: ${error.message}`); }
    }
    const pageToken = next?.pageToken || "";
    summary.capped ||= Boolean(pageToken);
    if (!dryRun) await checkpoint.set({ pageToken, updatedAt: Timestamp.fromMillis(now) });
  }
  logger.info(`[attachment-sweep] ${JSON.stringify(summary)}`);
  return summary;
}
