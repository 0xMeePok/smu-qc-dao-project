import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { archiveRecordId, retireRegistryDocument, writeRegistryRevision } from "../registryRetirement.js";
import { reserveRecord, reserveUpload } from "../resourceQuotas.js";

// Isolate the maintenance marker from other concurrently running callable tests.
const app = initializeApp({ projectId: "qcdao-retirement-test" }, "retirement-tests");
const db = getFirestore(app), registry = `0x${"a1".repeat(20)}`, uid = `0x${"b2".repeat(20)}`;
const now = Timestamp.now();
const maintenance = db.collection("maintenanceState").doc("registryCutover");
const archive = (path) => db.collection("registryArchives").doc(registry).collection("records").doc(archiveRecordId(path));
const retire = (path) => retireRegistryDocument({ db, sourceRef: db.doc(path), registry, now });
before(async () => maintenance.set({ active: true, registry }));
after(async () => { await db.terminate(); await deleteApp(app); });
describe("registry retirement preserves originals and closes legacy namespaces", () => {
  it("atomically archives typed data, retires its ID and removes only the active record", async () => {
    const original = { ownerId: uid, title: "Legacy", status: "submitted", createdAt: now, nested: { list: [1, "two"] } };
    await db.doc("problems/old-opportunity").set(original);
    assert.equal(await retire("problems/old-opportunity"), true);
    assert.equal((await db.doc("problems/old-opportunity").get()).exists, false);
    assert.deepEqual((await archive("problems/old-opportunity").get()).data().data, original);
    assert.equal((await db.doc("recordReservations/problems_old-opportunity").get()).data().retired, true);
    assert.equal(await retire("problems/old-opportunity"), false);
  });
  it("archives child history even after its parent is absent", async () => {
    await db.doc("problems/old-opportunity/revisions/revision1").set({ title: "Previous title", at: now });
    assert.equal(await retire("problems/old-opportunity/revisions/revision1"), true);
    assert.equal((await archive("problems/old-opportunity/revisions/revision1").get()).data().data.title, "Previous title");
  });
  it("routes late audit events directly to the archive after retirement", async () => {
    const entry = { changedFields: ["title"], at: now };
    await writeRegistryRevision({ db, scope: "problems", id: "old-opportunity", eventId: "late-event", entry });
    await writeRegistryRevision({ db, scope: "problems", id: "old-opportunity", eventId: "late-event", entry });
    const path = "problems/old-opportunity/revisions/late-event";
    assert.equal((await db.doc(path).get()).exists, false);
    assert.deepEqual((await archive(path).get()).data().data, entry);
  });
  it("retains quota and tombstones on retries without overwriting original reservations", async () => {
    const path = "uploadReservations/problems_legacy_file001";
    const original = { uid, state: "reserved", sealed: false, size: 1234, quotaReleasedAt: null };
    await db.doc(path).set(original);
    await retire(path); await retire(path);
    const marker = (await db.doc(path).get()).data();
    assert.equal(marker.state, "retired"); assert.equal(marker.sealed, true); assert.equal(marker.size, 1234);
    assert.deepEqual((await archive(path).get()).data().data, original);
  });
  it("will not replace an archive when a source is unexpectedly recreated", async () => {
    await db.doc("problems/old-opportunity").set({ ownerId: uid, title: "Late write" });
    await assert.rejects(retire("problems/old-opportunity"), /changed after archival/);
    assert.equal((await db.doc("problems/old-opportunity").get()).data().title, "Late write");
    assert.equal((await archive("problems/old-opportunity").get()).data().data.title, "Legacy");
    await db.doc("problems/old-opportunity").delete();
  });
  it("blocks creation during maintenance and retired-ID reuse after maintenance", async () => {
    await assert.rejects(reserveRecord({ db, scope: "problems", id: "new-opportunity", uid, now }), /maintenance/);
    await maintenance.set({ active: false, registry });
    await assert.rejects(retire("funding/absent"), /requires active maintenance/);
    await assert.rejects(reserveRecord({ db, scope: "problems", id: "old-opportunity", uid, now }), /retired/);
    await assert.rejects(reserveUpload({ db, scope: "problems", id: "old-opportunity", uid, now, Timestamp,
      attachmentId: "newfile01", size: 10, sha256: `0x${"1".repeat(64)}` }), /retired/);
    await reserveRecord({ db, scope: "problems", id: "new-opportunity", uid, now });
    assert.equal((await db.doc("recordReservations/problems_new-opportunity").get()).data().uid, uid);
  });
});
