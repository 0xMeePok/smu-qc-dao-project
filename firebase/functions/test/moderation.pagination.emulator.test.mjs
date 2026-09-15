import test from "node:test";
import assert from "node:assert/strict";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { listModerationQueue, listReportableComments } from "../moderation.js";

test("real Firestore queue and private-filtered discussion pagination preserve nanoseconds without skips or repeats", { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
  const id = `paging-${Date.now()}`;
  const app = initializeApp({ projectId: `qcdao-mod-page-${Date.now()}` }, id);
  // Firestore stores microsecond precision, still finer than ISO milliseconds.
  const db = getFirestore(app), time = new Timestamp(Math.floor(Date.now() / 1000), 123456000);
  const admin = `${id}-admin`, member = `${id}-member`, author = `${id}-author`;
  try {
    const batch = db.batch();
    batch.set(db.collection("users").doc(admin), { role: 1 });
    batch.set(db.collection("users").doc(member), { role: 0 });
    batch.set(db.collection("problems").doc(id), { ownerId: author, status: "submitted" });
    batch.set(db.collection("proposals").doc(id), { researcherId: author, problemId: id, postingOwnerId: author, status: "submitted" });
    for (let i = 0; i < 101; i++) {
      const suffix = String(i).padStart(3, "0");
      batch.set(db.collection("moderationQueue").doc(`comment_${id}-${suffix}`), {
        contentType: "comment", status: "pending", createdAt: time, sortReports: -2, reportCount: 2,
      });
      batch.set(db.collection("comments").doc(`${id}-${suffix}`), {
        authorId: author, problemId: id, ...(i < 100 ? { proposalId: id } : {}),
        text: i < 100 ? "Private author discussion" : "Public final comment", createdAt: time,
      });
    }
    await batch.commit();
    let cursor, ids = [];
    do {
      const page = await listModerationQueue({ db, uid: admin, contentType: "comment", cursor });
      ids.push(...page.items.map(row => row.id));
      cursor = page.nextCursor;
      if (cursor) assert.equal(cursor.nanoseconds, time.nanoseconds);
      assert.ok(ids.length <= 101, "queue must advance rather than repeat the first page");
    } while (cursor);
    assert.equal(ids.length, 101); assert.equal(new Set(ids).size, 101);
    const first = await listReportableComments({ db, uid: member, problemId: id });
    assert.deepEqual(first.items, []);
    assert.equal(first.nextCursor.nanoseconds, time.nanoseconds);
    const second = await listReportableComments({ db, uid: member, problemId: id, cursor: first.nextCursor });
    assert.deepEqual(second.items.map(row => row.body), ["Public final comment"]);
    assert.equal(second.nextCursor, null);
    assert.doesNotMatch(JSON.stringify([first, second]), /Private author discussion/);
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
});
