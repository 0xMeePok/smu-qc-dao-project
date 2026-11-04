import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, FieldPath, Timestamp } from "firebase-admin/firestore";
import {
  exportSelectedProposals, EXPORT_COMMENT_PAGE_SIZE, EXPORT_PAGE_BYTES,
  EXPORT_SESSION_BYTES, EXPORT_SESSION_COLLECTION,
} from "../proposalExport.js";

// Test-only SDK protobuf encoding proves the persisted document's actual wire
// size as well as the public JSON budget. No production code uses private SDK APIs.
const require = createRequire(import.meta.url);
const protoPath = resolve(dirname(require.resolve("@google-cloud/firestore")), "../protos/v1.json");
const Document = require("protobufjs").Root.fromJSON(require(protoPath)).lookupType("google.firestore.v1.Document");
const utc = (text) => Timestamp.fromDate(new Date(text));
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const timestampAfter = (left, right) => left.seconds > right.seconds
  || (left.seconds === right.seconds && left.nanoseconds > right.nanoseconds);

/** Real SDK proof; only run against the explicitly configured local emulator. */
test("real Firestore proposal export pagination, projection, system timestamps and atomic retries", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
  timeout: 180_000,
}, async (t) => {
  const fixture = `export-proof-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const app = initializeApp({ projectId: "demo-proposal-export-proof" }, fixture);
  const db = getFirestore(app), actorUid = `${fixture}-admin`, owned = new Set();
  const own = (collection, id) => { const ref = db.collection(collection).doc(id); owned.add(ref.path); return ref; };
  const call = (input) => exportSelectedProposals({ db, actorUid, actorName: "Export Proof Admin", input, now: Timestamp.now() });
  const old = utc("2026-01-01T00:00:00.000Z");
  async function write(records) {
    for (let offset = 0; offset < records.length; offset += 100) {
      const batch = db.batch();
      for (const [collection, id, data] of records.slice(offset, offset + 100)) batch.set(own(collection, id), data);
      await batch.commit();
    }
  }
  async function seed(label, count, bodyFor = (index) => `Comment ${index}`) {
    const id = `${fixture}-${label}`, records = [
      ["problems", id, { ownerId: "owner", title: "Posting", summary: "Posting summary", status: "submitted", hasAcceptedSolution: true,
        acceptedProposalId: id, opportunityType: "business-problem", categories: ["routing"], amount: 1, currency: "SGD", createdAt: old }],
      ["proposals", id, { problemId: id, researcherId: "researcher", title: "Proposal", summary: "Proposal summary", status: "accepted",
        matching: { status: "confirmed", confirmedAt: old, recommendations: { private: "not exported".repeat(5000) } },
        createdAt: old, updatedAt: old, attachments: [{ private: "not exported".repeat(5000) }] }],
      // An unrelated discussion must not affect this proposal's export scope.
      ["comments", `${fixture}-zz-highwater-${label}`, { proposalId: `${fixture}-outside`, body: "Unrelated", createdAt: old }],
    ];
    const ids = [];
    for (let index = 0; index < count; index++) {
      const commentId = `${id}-c${String(index).padStart(4, "0")}`;
      ids.push(commentId);
      const data = { proposalId: id, authorId: "member", authorRole: "user", body: bodyFor(index), parentId: null,
        moderationStatus: index % 3 === 0 ? "hidden" : index % 3 === 1 ? "removed" : "visible", qualifying: false,
        createdAt: old, updatedAt: old, revisions: [{ body: "Projection must omit this history".repeat(100) }] };
      if (index === 0) delete data.createdAt;
      if (index === 1) data.createdAt = utc("2099-01-01T00:00:00.000Z");
      if (index === 2) data.createdAt = "malformed legacy date";
      if (index === 3) data.deletedAt = old;
      records.push(["comments", commentId, data]);
    }
    await write(records);
    return { id, ids, input: { protocolVersion: 1, proposalId: id, requestId: `${fixture}-${label}-request` } };
  }
  async function checkPage(page) {
    assert.ok(bytes(page) <= EXPORT_PAGE_BYTES, `page ${page.page} exceeds UTF-8 budget`);
    const ref = own(EXPORT_SESSION_COLLECTION, page.exportId);
    const snap = await ref.get(), state = snap.data();
    if (!snap.exists) {
      const sessions = await db.collection(EXPORT_SESSION_COLLECTION).limit(100).get();
      console.error("EXPORT_MISSING_SESSION_DIAGNOSTIC", JSON.stringify({
        page: page.page, done: page.done, exportId: page.exportId, projectId: db.projectId,
        appProject: app.options.projectId, refPath: ref.path,
        readTime: snap.readTime?.toDate().toISOString(), sessionIds: sessions.docs.map((row) => row.id),
      }));
    }
    assert.ok(snap.exists, `Committed export session must exist after page ${page.page}`);
    assert.ok(state.readTime instanceof Timestamp);
    assert.ok(state.expiresAt instanceof Timestamp);
    assert.ok(bytes(state) <= EXPORT_SESSION_BYTES);
    assert.equal(snap._fieldsProto.actorUid.stringValue, actorUid);
    assert.equal(typeof snap._fieldsProto.lastResponse.stringValue, "string");
    const encodedBytes = Document.encode({
      name: `projects/${db.projectId}/databases/(default)/documents/${ref.path}`,
      fields: snap._fieldsProto,
    }).finish().length;
    assert.ok(encodedBytes >= Buffer.byteLength(state.lastResponse, "utf8"), "wire-size proof must include the cached response");
    assert.ok(encodedBytes < 1024 * 1024, `Firestore session wire size ${encodedBytes} exceeds 1 MiB`);
    assert.equal(Object.hasOwn(state, "pages"), false);
    if (page.auditId) own("audits", page.auditId);
    return state;
  }
  const commentsOf = (page) => page.document.postings.flatMap((posting) => posting.proposals.flatMap((proposal) => proposal.comments));
  async function checkAudit(page, proposalId, expected) {
    const rows = await db.collection("audits").where("actor", "==", actorUid).limit(100).get();
    const matching = rows.docs.filter((doc) => doc.data().proposalId === proposalId);
    assert.equal(matching.length, 1);
    const data = matching[0].data();
    assert.equal(matching[0].id, page.auditId);
    assert.equal(data.commentCount, expected);
    assert.equal(data.proposalCount, 1);
  }
  try {
    await t.test("1001 complete unique comments and real concurrent initial/final retries", async () => {
      const selected = await seed("short", 1001);
      // Projection retains authoritative system timestamps while dropping history.
      const projected = await db.collection("comments").where("proposalId", "==", selected.id)
        .orderBy(FieldPath.documentId(), "asc").select("body").limit(1).get();
      assert.deepEqual(Object.keys(projected.docs[0].data()), ["body"]);
      assert.ok(projected.readTime instanceof Timestamp);
      assert.ok(projected.docs[0].createTime instanceof Timestamp);
      const [first, initialRetry] = await Promise.all([call(selected.input), call(selected.input)]);
      assert.deepEqual(initialRetry, first);
      assert.equal(first.page, 0);
      assert.equal(first.document.postings[0].proposals[0].workflowStatus, "accepted");
      let page = first, pageCount = 0;
      const ids = new Set();
      while (true) {
        await checkPage(page);
        pageCount++;
        for (const comment of commentsOf(page)) {
          assert.equal(ids.has(comment.id), false, `duplicate ${comment.id}`);
          ids.add(comment.id);
          assert.equal(Object.hasOwn(comment, "revisions"), false);
        }
        if (page.done) break;
        if (ids.size === 1000) {
          const [final, finalRetry] = await Promise.all([call(page.nextCursor), call(page.nextCursor)]);
          assert.deepEqual(finalRetry, final);
          assert.equal(final.done, true);
          assert.deepEqual(await call(page.nextCursor), final);
          page = final;
        } else page = await call(page.nextCursor);
        assert.ok(pageCount <= 23, "continuations must advance");
      }
      assert.ok(pageCount >= 21);
      assert.deepEqual([...ids].sort(), [...selected.ids].sort());
      assert.equal(page.totals.commentCount, 1001);
      await checkAudit(page, selected.id, 1001);
    });

    await t.test("51 maximum-length Unicode and escaped comments stay within real encoded page/state budgets", async () => {
      const bodies = ["漢".repeat(5000), '"\\\r\n'.repeat(1250)];
      assert.equal(bodies[0].length, 5000);
      assert.equal(bodies[1].length, 5000);
      const selected = await seed("wide", 51, (index) => bodies[index % 2]);
      let page = await call(selected.input), pageCount = 0;
      const ids = new Set();
      while (true) {
        await checkPage(page);
        pageCount++;
        assert.ok(page.document.commentCount <= EXPORT_COMMENT_PAGE_SIZE);
        for (const comment of commentsOf(page)) {
          assert.equal(ids.has(comment.id), false);
          ids.add(comment.id);
          const index = selected.ids.indexOf(comment.id);
          assert.equal(comment.body, bodies[index % 2]);
        }
        if (page.done) break;
        page = await call(page.nextCursor);
        assert.ok(pageCount <= 10);
      }
      assert.ok(pageCount >= 3, "UTF-8 byte budget must reduce the 50-document page");
      assert.equal(ids.size, 51);
      assert.equal(page.totals.commentCount, 51);
      await checkAudit(page, selected.id, 51);
    });

    await t.test("system creation cutoff retains legacy dates, excludes new lower IDs and reads later body edits", async () => {
      const selected = await seed("cutoff", 51);
      const first = await call(selected.input), state = await checkPage(first);
      const initial = commentsOf(first);
      assert.equal(initial.length, 50);
      assert.equal(initial[0].createdAt, null);
      assert.equal(initial[1].createdAt, "2099-01-01T00:00:00.000Z");
      assert.equal(initial[2].createdAt, null);
      const oldSnap = await db.collection("comments").doc(selected.ids[0]).get();
      assert.equal(timestampAfter(oldSnap.createTime, state.readTime), false);
      const lateIds = [`${selected.id}-c0049a`, `${selected.id}-c0049b`];
      await write(lateIds.map((id, index) => ["comments", id, {
        proposalId: selected.id, authorId: "member", body: `Late ${index}`, parentId: null,
        createdAt: index ? utc("2099-01-01T00:00:00.000Z") : utc("2020-01-01T00:00:00.000Z"),
      }]));
      for (const id of lateIds) {
        assert.ok(id > selected.ids[49] && id < selected.ids[50]);
        const late = await db.collection("comments").doc(id).get();
        assert.equal(timestampAfter(late.createTime, state.readTime), true);
      }
      const liveBody = 'A later edit, with "quotes" and 漢字.';
      await db.collection("comments").doc(selected.ids[50]).update({ body: liveBody, updatedAt: Timestamp.now() });
      const last = await call(first.nextCursor);
      await checkPage(last);
      assert.equal(last.done, true);
      assert.deepEqual(commentsOf(last).map((comment) => comment.id), [selected.ids[50]]);
      assert.equal(commentsOf(last)[0].body, liveBody);
      assert.equal(last.totals.commentCount, 51);
      await checkAudit(last, selected.id, 51);
    });
  } finally {
    // Scope cleanup to this test's exact IDs/actor. Never clear emulator fixtures.
    for (const collection of [EXPORT_SESSION_COLLECTION, "audits"]) {
      const rows = await db.collection(collection).where(collection === "audits" ? "actor" : "actorUid", "==", actorUid).limit(100).get();
      for (const doc of rows.docs) owned.add(doc.ref.path);
    }
    const paths = [...owned];
    for (let offset = 0; offset < paths.length; offset += 100) {
      const batch = db.batch();
      for (const path of paths.slice(offset, offset + 100)) batch.delete(db.doc(path));
      await batch.commit();
    }
    await db.terminate();
    await deleteApp(app);
  }
});
