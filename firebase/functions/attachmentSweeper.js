/**
 * QCDAO-58 - orphaned posting attachments.
 *
 * An orphan is a completed object under problems/ that no posting references.
 *
 * This is NOT primarily an abuse problem. App Check enforcement on Cloud Storage
 * already stops a script with a valid ID token from bulk-uploading. Orphans are
 * mostly made by ordinary use: someone uploads a PDF, then abandons the form or
 * closes the tab before publishing. The client deletes what it can when a draft is
 * abandoned deliberately, but a closed tab cannot be cleaned up from the browser -
 * there is no reliable moment to run a delete in. So the bucket accumulates real
 * files nothing points at, and something server-side has to notice.
 *
 * The lifecycle rule in storage.lifecycle.json only aborts INCOMPLETE resumable
 * uploads. A completed upload that no posting references is a different thing, and
 * this is what handles it.
 *
 * Everything that decides WHAT to delete is a pure function below, so the rules can
 * be tested exhaustively without a bucket. Only sweepOrphanedAttachments() touches
 * Firestore or Storage.
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
  if (prefix !== "problems") return null;
  if (!/^0x[0-9a-f]{40}$/.test(ownerId)) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(problemId)) return null;
  if (!/^[A-Za-z0-9._-]{1,120}\.pdf$/.test(fileName)) return null;

  return { ownerId, problemId, attachmentId: fileName.replace(/\.pdf$/, "") };
}

/**
 * The set of storage paths that postings actually point at. Anything in the bucket
 * and not in this set is unreferenced.
 */
export function collectReferencedPaths(postings) {
  const referenced = new Set();
  for (const posting of postings) {
    const attachments = Array.isArray(posting?.attachments) ? posting.attachments : [];
    for (const attachment of attachments) {
      if (typeof attachment?.path === "string") referenced.add(attachment.path);
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
 * Reads the bucket and the postings, plans the sweep, and (unless dryRun) deletes.
 *
 * Deliberately dry-run by default at the call site in index.js: this is the one
 * scheduled job in the project that destroys data, and it should prove itself
 * against real content in the logs before it is allowed to act.
 */
export async function sweepOrphanedAttachments({
  db,
  bucket,
  dryRun = true,
  now = Date.now(),
  graceMs = DEFAULT_GRACE_MS,
  logger = console,
}) {
  const [files] = await bucket.getFiles({ prefix: ATTACHMENT_PREFIX });
  const objects = files.map((file) => ({
    path: file.name,
    createdAt: Date.parse(file.metadata?.timeCreated ?? ""),
    ref: file,
  }));

  const snapshot = await db.collection("problems").get();
  const referencedPaths = collectReferencedPaths(snapshot.docs.map((doc) => doc.data()));

  const plan = planSweep({ objects, referencedPaths, now, graceMs });
  const byPath = new Map(objects.map((object) => [object.path, object]));

  if (plan.capped) {
    logger.warn(
      `[attachment-sweep] deletion plan hit the ${MAX_DELETES_PER_RUN} cap. `
      + "Investigate before assuming this is a normal backlog.",
    );
  }

  let deleted = 0;
  if (!dryRun) {
    for (const path of plan.deletions) {
      try {
        await byPath.get(path).ref.delete();
        deleted += 1;
      } catch (error) {
        // Another run, or the owner, may have removed it already. Not a failure.
        logger.warn(`[attachment-sweep] could not delete ${path}: ${error.message}`);
      }
    }
  }

  const summary = {
    scanned: objects.length,
    referenced: plan.kept,
    orphans: plan.deletions.length,
    deleted,
    skipped: plan.skipped.length,
    capped: plan.capped,
    dryRun,
  };

  logger.info(`[attachment-sweep] ${JSON.stringify(summary)}`);
  if (dryRun && plan.deletions.length > 0) {
    logger.info(
      `[attachment-sweep] DRY RUN - would have deleted ${plan.deletions.length} object(s). `
      + "Set ATTACHMENT_SWEEP_ENABLED=true to act on this.",
    );
  }

  return summary;
}
