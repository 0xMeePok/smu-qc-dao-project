import assert from "node:assert/strict";
import { it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { memoryDb } from "./memoryDb.mjs";
import { backfillEvidenceQuotaPage } from "../evidenceQuotaMigration.js";
import { evidenceChargeId, evidenceCounterKeys } from "../evidenceQuotas.js";
import { hashDeliveryEvidence, persistDeliveryEvidence } from "../deliveryEvidence.js";

const uid = `0x${"a".repeat(40)}`, now = Timestamp.fromDate(new Date("2026-11-05T00:00:00Z"));
const historical = Timestamp.fromDate(new Date("2025-01-02T00:00:00Z"));

// Faithful collection-group ordering by complete document name. Unlike a parent
// walk this includes children whose proposal root has been removed/retired.
function migrationDb(initial = {}) {
  const db = memoryDb(initial);
  db.collectionGroup = name => {
    const query = (cap = Infinity, cursor = "") => ({
      orderBy: () => query(cap, cursor), limit: size => query(size, cursor),
      startAfter: ref => query(cap, ref.path),
      get: async () => ({ docs: await Promise.all([...db.records.keys()]
        .filter(path => path.split("/").at(-2) === name && path > cursor).sort().slice(0, cap)
        .map(path => { const split = path.lastIndexOf("/"); return db.collection(path.slice(0, split)).doc(path.slice(split + 1)).get(); })) }),
    });
    return query();
  };
  return db;
}
const finish = async (db, pageSize = 2) => {
  for (let page = 0; page < 100; page++) if ((await backfillEvidenceQuotaPage({ db, now, pageSize })).done) return;
  throw new Error("Migration did not finish within bounded fixture pages");
};

it("backfills both actual groups including malformed/orphan/retired evidence without mutating originals", async () => {
  const original = {
    "proposals/retired/deliveryEvidence/arbitrary.id": { ownerId: uid.toUpperCase().replace("0X", "0x"), summary: "Legacy staged", createdAt: historical },
    "proposals/orphan/independentFundingEvidence/not-a-digest": { ownerId: "invalid/owner", summary: "Malformed retained bytes", createdAt: "bad" },
    "proposals/retired/deliveryEvidence/z": { summary: "Missing owner and timestamp" },
    "recordReservations/proposals_retired": { retired: true },
  };
  const db = migrationDb(original);
  const first = await backfillEvidenceQuotaPage({ db, now, pageSize: 1 });
  assert.equal(first.done, false);
  assert.equal(db.records.get("maintenanceState/evidenceQuotasV1").ready, false);
  await finish(db, 1);
  assert.deepEqual(db.records.get("maintenanceState/evidenceQuotasV1"), {
    version: 1, ready: true, phase: 1, lastPath: "", updatedAt: now,
  });
  for (const [path, data] of Object.entries(original)) assert.deepEqual(db.records.get(path), data);
  assert.equal(db.records.get("evidenceQuotas/global").count, 3);
  const firstCharge = db.records.get(`evidenceCharges/${evidenceChargeId("proposals/retired/deliveryEvidence/arbitrary.id")}`);
  assert.equal(firstCharge.day, "2025-01-02"); assert.equal(firstCharge.ownerBucket, uid);
  const invalidCharge = db.records.get(`evidenceCharges/${evidenceChargeId("proposals/orphan/independentFundingEvidence/not-a-digest")}`);
  assert.equal(invalidCharge.day, "2026-11-05"); assert.equal(invalidCharge.ownerBucket, "legacy-invalid-owner");
  const proposalKey = evidenceCounterKeys({ proposalPath: "proposals/retired", ownerBucket: uid, day: "2025-01-02" })[2];
  assert.equal(db.records.get(`evidenceQuotas/${proposalKey}`).count, 2);
  const before = new Map(db.records);
  assert.deepEqual(await backfillEvidenceQuotaPage({ db, now }), { done: true, scanned: 0 });
  assert.deepEqual(db.records, before);
});

it("replays an interrupted page using per-document idempotent charges", async () => {
  const db = migrationDb(Object.fromEntries(Array.from({ length: 3 }, (_, i) => [
    `proposals/p/deliveryEvidence/${i}`, { ownerId: uid, createdAt: historical },
  ])));
  const transaction = db.runTransaction.bind(db);
  let calls = 0;
  db.runTransaction = callback => ++calls === 2 ? Promise.reject(new Error("interruption")) : transaction(callback);
  await assert.rejects(backfillEvidenceQuotaPage({ db, now, pageSize: 3 }), /interruption/);
  assert.equal(db.records.get("evidenceQuotas/global").count, 1);
  assert.equal(db.records.has("maintenanceState/evidenceQuotasV1"), false);
  db.runTransaction = transaction;
  await finish(db, 3);
  assert.equal(db.records.get("evidenceQuotas/global").count, 3);
  assert.equal([...db.records.keys()].filter(path => path.startsWith("evidenceCharges/")).length, 3);
});

it("concurrent bounded runners cannot double charge or regress completion", async () => {
  const db = migrationDb(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [
    `proposals/p/${i % 2 ? "deliveryEvidence" : "independentFundingEvidence"}/${i}`, { ownerId: uid },
  ])));
  for (let attempt = 0; attempt < 20 && !db.records.get("maintenanceState/evidenceQuotasV1")?.ready; attempt++) {
    await Promise.all(Array.from({ length: 3 }, () => backfillEvidenceQuotaPage({ db, now, pageSize: 2 })));
  }
  assert.equal(db.records.get("maintenanceState/evidenceQuotasV1").ready, true);
  assert.equal(db.records.get("evidenceQuotas/global").count, 8);
});

it("retains an over-limit legacy dataset: exact retries work and new distinct content is refused", async () => {
  const evidence = { summary: "Real retained content", url: "https://example.org/results" }, hash = hashDeliveryEvidence(evidence);
  const db = migrationDb({ [`users/${uid}`]: { role: 0 },
    "proposals/p": { researcherId: uid, status: "submitted", fundingTerms: {} },
    ...Object.fromEntries(Array.from({ length: 101 }, (_, i) => [
      `proposals/p/${i % 2 ? "deliveryEvidence" : "independentFundingEvidence"}/${i === 1 ? hash : i}`,
      i === 1 ? { ...evidence, ownerId: uid, createdAt: historical } : { ownerId: uid, createdAt: historical },
    ])),
  });
  await finish(db, 100);
  assert.equal(db.records.get("evidenceQuotas/global").count, 101);
  const before = new Map(db.records);
  await persistDeliveryEvidence({ db, uid, proposalId: "p", evidence, evidenceHash: hash, now });
  assert.deepEqual(db.records, before);
  const next = { ...evidence, summary: "A new distinct delivery" };
  await assert.rejects(persistDeliveryEvidence({ db, uid, proposalId: "p", evidence: next,
    evidenceHash: hashDeliveryEvidence(next), now }), error => error.code === "resource-exhausted");
});

it("bounds every scan and validates migration page size", async () => {
  const db = migrationDb();
  for (const pageSize of [0, 101, 1.5]) await assert.rejects(backfillEvidenceQuotaPage({ db, now, pageSize }), /page size/);
  assert.equal((await backfillEvidenceQuotaPage({ db, now, pageSize: 1 })).done, false);
  assert.equal((await backfillEvidenceQuotaPage({ db, now, pageSize: 1 })).done, true);
  const unsupported = migrationDb({ "maintenanceState/evidenceQuotasV1": { ready: true, version: 2 } });
  await assert.rejects(backfillEvidenceQuotaPage({ db: unsupported, now }), /Unsupported/);
});
