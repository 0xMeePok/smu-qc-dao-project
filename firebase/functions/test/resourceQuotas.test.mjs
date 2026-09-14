import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { reserveRecord, reserveUpload, retireUpload, releaseDeletedUpload,
  uploadObjectPath, uploadReservationKey } from "../resourceQuotas.js";
import { memoryDb } from "./memoryDb.mjs";

const uid = `0x${"a".repeat(40)}`;
const now = Timestamp.fromDate(new Date("2026-09-14T01:00:00Z"));
describe("QCDAO-132/134/139 trusted quotas", () => {
  it("atomically limits unique records while allowing retries and denying ID takeover", async () => {
    const db = memoryDb();
    const reserve = (id, actor = uid) => reserveRecord({ db, scope: "proposals", id, uid: actor, now });
    const outcomes = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => reserve(`draft${i}`)));
    assert.equal(outcomes.filter((v) => v.status === "fulfilled").length, 30);
    await reserve("draft0");
    await assert.rejects(reserve("draft0", `0x${"b".repeat(40)}`), /another member/);
  });
  it("charges per-record uploads, rejects reuse, and releases abandoned reservations only once", async () => {
    const db = memoryDb();
    const reserve = (attachmentId) => reserveUpload({ db, scope: "problems", id: "p", uid,
      attachmentId, size: 10 * 1024 * 1024, sha256: `0x${"1".repeat(64)}`, now, Timestamp });
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reserve(`file000${i}`)));
    assert.equal(results.filter((v) => v.status === "fulfilled").length, 10);
    const key = uploadReservationKey("problems", "p", "file0000");
    const path = uploadObjectPath("problems", uid, "p", "file0000");
    await retireUpload({ db, key, expectedPath: path, now });
    assert.equal(db.records.get("uploadQuotas/problems_p").count, 10, "failed deletion must retain the charge");
    await assert.rejects(releaseDeletedUpload({ db, key, deletedPath: `${path}.alias`, now }), /only after deleting/);
    await releaseDeletedUpload({ db, key, deletedPath: path, now });
    await releaseDeletedUpload({ db, key, deletedPath: path, now });
    assert.equal(db.records.get(`uploadQuotas/${uid}`).bytes, 90 * 1024 * 1024);
    await assert.rejects(reserve("file0000"), /fresh upload/);
    await reserve("file_new");
  });
  it("does not retire sealed evidence or add files to a submitted proposal", async () => {
    const db = memoryDb({ "uploadReservations/r": { sealed: true, state: "reserved", path: "problems/x/p/file0001.pdf" },
      "proposals/p": { researcherId: uid, status: "submitted" } });
    await assert.rejects(retireUpload({ db, key: "r", expectedPath: "problems/x/p/file0001.pdf", now }), /retained/);
    await assert.rejects(reserveUpload({ db, scope: "proposals", id: "p", uid,
      attachmentId: "file0001", size: 10, sha256: `0x${"1".repeat(64)}`, now, Timestamp }), /frozen/);
  });
});

it("QCDAO-134 uses an injective upload reservation key for underscore-bearing IDs", () => {
  assert.notEqual(
    uploadReservationKey("problems", "p_a", "file0001"),
    uploadReservationKey("problems", "p", "a_file0001"),
  );
});


it("QCDAO-134 caps total additional storage across rotating wallets", async () => {
  const db = memoryDb({ "uploadQuotas/global": { bytes: 5 * 1024 * 1024 * 1024 - 10 } });
  const reserve = (actor, id) => reserveUpload({ db, scope: "problems", id, uid: actor,
    attachmentId: "file0001", size: 10, sha256: `0x${"1".repeat(64)}`, now, Timestamp });
  await reserve(uid, "a");
  await assert.rejects(reserve(`0x${"b".repeat(40)}`, "b"), /quota/);
});
