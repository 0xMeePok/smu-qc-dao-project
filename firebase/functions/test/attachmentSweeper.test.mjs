import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_GRACE_MS,
  MAX_DELETES_PER_RUN,
  collectReferencedPaths,
  parseAttachmentPath,
  planSweep,
  sweepOrphanedAttachments,
} from "../attachmentSweeper.js";

/**
 * QCDAO-58 remediation - the orphan sweeper.
 *
 * This is the only scheduled job in the project that deletes user data, so the
 * tests are written from the "what must NEVER be deleted" side first. A sweeper
 * that misses an orphan costs a few cents; one that deletes a live attachment
 * loses a document somebody attached to a real posting.
 */

const OWNER = `0x${"a".repeat(40)}`;
const NOW = Date.parse("2026-08-31T12:00:00Z");
const OLD = NOW - DEFAULT_GRACE_MS - 1000;
const RECENT = NOW - 60 * 1000;

function objectAt(path, createdAt = OLD) {
  return { path, createdAt };
}

function livePath(problemId = "p1", id = "abc123xy") {
  return `problems/${OWNER}/${problemId}/${id}.pdf`;
}

describe("parseAttachmentPath", () => {
  it("[BUT-OPD-006] accepts the exact shape the uploader writes", () => {
    assert.deepEqual(parseAttachmentPath(livePath()), {
      ownerId: OWNER,
      problemId: "p1",
      attachmentId: "abc123xy",
    });
  });

  it("[BUT-OPD-007] rejects anything that is not that shape, so it is never a delete candidate", () => {
    const rejected = [
      "problems/notanaddress/p1/abc123xy.pdf",
      `problems/${OWNER}/p1/abc123xy.html`,
      `problems/${OWNER}/p1/nested/abc123xy.pdf`,
      `problems/${OWNER}/p1`,
      `uploads/${OWNER}/p1/abc123xy.pdf`,
      `problems/${OWNER.toUpperCase()}/p1/abc123xy.pdf`,
      `problems/${OWNER}/${"x".repeat(65)}/abc123xy.pdf`,
      "",
      null,
      undefined,
      42,
    ];
    for (const path of rejected) {
      assert.equal(parseAttachmentPath(path), null, `should reject ${String(path)}`);
    }
  });
});

describe("collectReferencedPaths", () => {
  // Records no longer store `path`, so it has to be rebuilt from the posting.
  // Fixtures carrying `path` would pass while every real attachment was swept.
  it("[BUT-OPD-008] rebuilds the path from the posting and attachment id", () => {
    const referenced = collectReferencedPaths([
      { id: "post1", ownerId: OWNER, attachments: [{ id: "a1" }, { id: "a2" }] },
      { id: "post2", ownerId: OWNER, attachments: [{ id: "b1" }] },
    ]);
    assert.deepEqual([...referenced].sort(), [
      `problems/${OWNER}/post1/a1.pdf`,
      `problems/${OWNER}/post1/a2.pdf`,
      `problems/${OWNER}/post2/b1.pdf`,
    ]);
  });

  it("[BUT-OPD-009] tolerates postings with no attachments, or malformed ones", () => {
    const referenced = collectReferencedPaths([
      {},
      { attachments: null },
      { attachments: "not-a-list" },
      { id: "post1", ownerId: OWNER, attachments: [{}, { id: null }, { id: "ok" }] },
      null,
    ]);
    assert.deepEqual([...referenced], [`problems/${OWNER}/post1/ok.pdf`]);
  });

  it("[BUT-OPD-020] still honours the legacy stored path", () => {
    const referenced = collectReferencedPaths([
      { id: "post1", ownerId: OWNER, attachments: [{ id: "a1", path: "legacy/a1.pdf" }] },
    ]);
    assert.ok(referenced.has("legacy/a1.pdf"));
    assert.ok(referenced.has(`problems/${OWNER}/post1/a1.pdf`));
  });

  it("[BUT-OPD-021] uppercase ownerId still matches the lowercase object path", () => {
    const referenced = collectReferencedPaths([
      { id: "post1", ownerId: OWNER.toUpperCase(), attachments: [{ id: "a1" }] },
    ]);
    assert.ok(referenced.has(`problems/${OWNER}/post1/a1.pdf`));
  });
});

describe("planSweep", () => {
  it("[BUT-OPD-010] deletes an old object that no posting references", () => {
    const plan = planSweep({
      objects: [objectAt(livePath())],
      referencedPaths: new Set(),
      now: NOW,
    });
    assert.deepEqual(plan.deletions, [livePath()]);
  });

  it("[BUT-OPD-011] NEVER deletes an object a posting references, however old", () => {
    const plan = planSweep({
      objects: [objectAt(livePath(), 0)],
      referencedPaths: new Set([livePath()]),
      now: NOW,
    });
    assert.deepEqual(plan.deletions, []);
    assert.equal(plan.kept, 1);
  });

  it("[BUT-OPD-012] NEVER deletes an unreferenced object inside the grace period", () => {
    // The remove-before-publish case: uploaded moments ago, onto a form the user
    // is still filling in, so no posting references it yet. Deleting this would
    // make the feature delete files out from under people as they work.
    const plan = planSweep({
      objects: [objectAt(livePath(), RECENT)],
      referencedPaths: new Set(),
      now: NOW,
    });
    assert.deepEqual(plan.deletions, []);
    assert.deepEqual(plan.skipped, [{ path: livePath(), reason: "within-grace-period" }]);
  });

  it("[BUT-OPD-013] NEVER deletes a path it cannot parse", () => {
    const plan = planSweep({
      objects: [objectAt("problems/weird/thing"), objectAt("something/else.pdf")],
      referencedPaths: new Set(),
      now: NOW,
    });
    assert.deepEqual(plan.deletions, []);
    assert.equal(plan.skipped.length, 2);
    assert.ok(plan.skipped.every((entry) => entry.reason === "unrecognised-path"));
  });

  it("[BUT-OPD-014] NEVER deletes an object whose age is unknown", () => {
    // A missing or unparseable timeCreated must not be treated as "infinitely old".
    const plan = planSweep({
      objects: [{ path: livePath(), createdAt: NaN }],
      referencedPaths: new Set(),
      now: NOW,
    });
    assert.deepEqual(plan.deletions, []);
    assert.deepEqual(plan.skipped, [{ path: livePath(), reason: "unknown-age" }]);
  });

  it("[BUT-OPD-015] caps a runaway plan rather than emptying the bucket in one pass", () => {
    const objects = Array.from({ length: MAX_DELETES_PER_RUN + 25 }, (_, index) =>
      objectAt(livePath("p1", `attach${index}`)));
    const plan = planSweep({ objects, referencedPaths: new Set(), now: NOW });

    assert.equal(plan.deletions.length, MAX_DELETES_PER_RUN);
    assert.equal(plan.capped, true);
  });
});

describe("sweepOrphanedAttachments", () => {
  function harness({ files, postings, afterSnapshot }) {
    const deleted = [];
    const store = new Map((postings ?? []).map((posting) => [posting.id ?? "unknown", posting]));
    const bucket = {
      getFiles: async () => [files.map(({ path, createdAt }) => ({
        name: path,
        metadata: { timeCreated: new Date(createdAt).toISOString() },
        delete: async () => { deleted.push(path); },
      }))],
    };
    const db = {
      collection: () => ({
        get: async () => {
          const docs = [...store.entries()].map(([id, data]) => ({
            id,
            data: () => data,
          }));
          afterSnapshot?.(store);
          return { docs };
        },
        doc: (id) => ({
          get: async () => {
            const data = store.get(id);
            return {
              exists: data !== undefined,
              id,
              data: () => data,
            };
          },
        }),
      }),
    };
    return { db, bucket, deleted, store, logger: { info() {}, warn() {} } };
  }

  it("[BUT-OPD-016] deletes nothing in dry-run mode, but still reports what it would remove", async () => {
    const { db, bucket, deleted, logger } = harness({
      files: [objectAt(livePath())],
      postings: [],
    });

    const summary = await sweepOrphanedAttachments({ db, bucket, dryRun: true, now: NOW, logger });

    assert.deepEqual(deleted, []);
    assert.equal(summary.orphans, 1);
    assert.equal(summary.deleted, 0);
    assert.equal(summary.dryRun, true);
  });

  it("[BUT-OPD-017] deletes only the orphan when enabled", async () => {
    const keep = livePath("p1", "keepme01");
    const orphan = livePath("p1", "orphan01");
    const { db, bucket, deleted, logger } = harness({
      files: [objectAt(keep), objectAt(orphan)],
      postings: [{ id: "p1", ownerId: OWNER, attachments: [{ id: "keepme01" }] }],
    });

    const summary = await sweepOrphanedAttachments({ db, bucket, dryRun: false, now: NOW, logger });

    assert.deepEqual(deleted, [orphan]);
    assert.equal(summary.referenced, 1);
    assert.equal(summary.deleted, 1);
  });

  it("[BUT-OPD-018] keeps going when one delete fails", async () => {
    // Another run, or the owner, may have removed it first. That is not a failure.
    const first = livePath("p1", "gone0001");
    const second = livePath("p1", "orphan02");
    const { db, bucket, deleted, logger } = harness({
      files: [objectAt(first), objectAt(second)],
      postings: [],
    });
    const files = (await bucket.getFiles())[0];
    files[0].delete = async () => { throw new Error("404 not found"); };
    bucket.getFiles = async () => [files];

    const summary = await sweepOrphanedAttachments({ db, bucket, dryRun: false, now: NOW, logger });

    assert.deepEqual(deleted, [second]);
    assert.equal(summary.deleted, 1);
  });

  it("[BUT-OPD-019] does not delete a file published after the snapshot and before the delete", async () => {
    const path = livePath("p1", "latepub01");
    const { db, bucket, deleted, logger } = harness({
      files: [objectAt(path)],
      postings: [],
      afterSnapshot(store) {
        store.set("p1", { id: "p1", ownerId: OWNER, attachments: [{ id: "latepub01" }] });
      },
    });

    const summary = await sweepOrphanedAttachments({ db, bucket, dryRun: false, now: NOW, logger });

    assert.deepEqual(deleted, []);
    assert.equal(summary.orphans, 1);
    assert.equal(summary.deleted, 0);
  });
});
