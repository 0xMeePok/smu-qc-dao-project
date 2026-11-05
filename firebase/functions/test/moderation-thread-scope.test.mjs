import assert from "node:assert/strict";
import { test } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { memoryDb } from "./memoryDb.mjs";
import { listReportableComments } from "../moderation.js";

const now = Timestamp.fromMillis(1_900_000_000_000);
function fixture() {
  const db = memoryDb({
    "users/member": { role: 0 }, "users/author": { role: 0 }, "users/admin": { role: 1 },
    "problems/victim": { ownerId: "member", status: "draft" },
    "problems/real-parent": { ownerId: "sponsor", status: "submitted" },
    "proposals/victim": { researcherId: "author", problemId: "real-parent", status: "moderated_removed", moderationStatus: "removed" },
    "comments/thread": { authorId: "author", proposalId: "victim", problemId: "real-parent",
      parentId: null, status: "submitted", body: "Thread", replyCount: 25, createdAt: now },
  });
  for (let index = 0; index < 25; index++) db.records.set(`comments/reply-${String(index).padStart(2, "0")}`, {
    authorId: "author", proposalId: "victim", problemId: "real-parent", parentId: "thread",
    status: "submitted", body: `Secret reply ${index}`, createdAt: Timestamp.fromMillis(now.toMillis() + index + 1),
  });
  return db;
}

for (const proposalId of [undefined, "", null, false, 0]) {
  test(`colliding problem cannot authorize proposal replies with proposalId=${String(proposalId)}`, async () => {
    const db = fixture();
    await assert.rejects(listReportableComments({ db, uid: "member", proposalId: "victim", threadId: "thread" }), { code: "permission-denied" });
    await assert.rejects(listReportableComments({ db, uid: "member", problemId: "victim", proposalId, threadId: "thread" }), { code: "invalid-argument" });
  });
}

test("a public colliding problem and a retained reply cursor cannot bypass proposal moderation", async () => {
  const db = fixture();
  db.records.set("problems/victim", { ownerId: "another-member", status: "submitted" });
  const page = await listReportableComments({ db, uid: "author", proposalId: "victim", threadId: "thread" });
  assert.ok(page.nextCursor);
  await assert.rejects(listReportableComments({ db, uid: "member", problemId: "victim", threadId: "thread", cursor: page.nextCursor }), { code: "invalid-argument" });
  assert.deepEqual((await listReportableComments({ db, uid: "member", problemId: "victim" })).items, []);
});

test("properly scoped author/admin pages preserve removed-proposal access and reply pagination", async () => {
  for (const uid of ["author", "admin"]) {
    const db = fixture();
    const first = await listReportableComments({ db, uid, problemId: "real-parent", proposalId: "victim", threadId: "thread" });
    assert.ok(first.items.length > 0); assert.ok(first.nextCursor);
    const next = await listReportableComments({ db, uid, proposalId: "victim", threadId: "thread", cursor: first.nextCursor });
    assert.equal(new Set([...first.items, ...next.items].map(row => row.id)).size, 25);
    assert.ok([...first.items, ...next.items].every(row => row.proposalId === "victim" && row.parentId === "thread"));
  }
});

test("visible and independent proposal thread pages retain their actual parent ACL and reply filters", async () => {
  for (const independent of [false, true]) {
    const db = fixture();
    db.records.set("proposals/victim", { researcherId: "author", status: "submitted",
      ...(independent ? { proposalKind: "independent" } : { problemId: "real-parent", postingOwnerId: "sponsor" }) });
    db.records.get("comments/reply-00").moderationStatus = "hidden";
    db.records.get("comments/reply-01").deletedAt = now;
    const page = await listReportableComments({ db, uid: "member", proposalId: "victim", threadId: "thread" });
    assert.ok(page.items.length > 0);
    assert.ok(page.items.every(row => !["reply-00", "reply-01"].includes(row.id)));
    if (!independent) await assert.rejects(listReportableComments({ db, uid: "member", problemId: "wrong", proposalId: "victim", threadId: "thread" }), { code: "permission-denied" });
  }
});
