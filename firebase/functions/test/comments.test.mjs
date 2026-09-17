import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { memoryDb } from "./memoryDb.mjs";
import { COMMENT_EDIT_WINDOW_MS, COMMENT_BODY_MAX, createComment, deleteComment, editComment } from "../comments.js";
import { listReportableComments } from "../moderation.js";

const now = Timestamp.fromMillis(1_800_000_000_000);
const later = (ms) => Timestamp.fromMillis(now.toMillis() + ms);
function fixture() {
  return memoryDb({
    "users/admin": { role: 1, fullName: "Moderator" },
    "users/owner": { role: 0, fullName: "Problem owner" },
    "users/alice": { role: 0, fullName: "Alice" },
    "users/funder": { role: 0, fullName: "Funder" },
    "users/evaluator": { role: 2, fullName: "Assigned evaluator" },
    "users/suspended": { role: 2, suspended: true },
    "problems/problem": { ownerId: "owner", title: "Routing study", summary: "Improve routes",
      status: "submitted", createdAt: now },
    "proposals/a": { researcherId: "alice", postingOwnerId: "owner", problemId: "problem",
      title: "Proposal A", summary: "A routing approach", status: "submitted", createdAt: now },
    "proposals/draft": { researcherId: "alice", problemId: "problem", title: "Draft",
      status: "draft", createdAt: now },
  });
}
const create = (db, patch = {}) => createComment({ db, uid: "funder", proposalId: "a",
  body: "The claimed latency needs a cited benchmark.", now, ...patch });
const comments = (db) => [...db.records.entries()].filter(([path]) => path.startsWith("comments/"));

test("members can comment on a submitted proposal; evaluators must recommend and receive a server badge", async () => {
  const db = fixture();
  const member = await create(db);
  assert.equal(member.authorId, "funder");
  assert.equal(member.authorRole, "user");
  assert.equal(member.badge, null);
  assert.equal(member.recommendation, null);
  assert.equal(member.qualifying, false);
  assert.equal(member.parentId, null);
  assert.equal(member.problemId, "problem");
  const stored = db.records.get(`comments/${member.id}`);
  assert.equal(stored.qftGrade, null);
  assert.equal(stored.qftGradedAt, null);
  assert.equal(stored.qftGradedBy, null);
  assert.equal(stored.authorId, "funder");

  await assert.rejects(() => create(db, { uid: "evaluator" }), { code: "invalid-argument" });
  await assert.rejects(() => create(db, { uid: "evaluator", recommendation: "approve" }), { code: "invalid-argument" });
  const evaluator = await create(db, { uid: "evaluator", recommendation: "recommend_with_revisions",
    authorId: "alice", badge: "evaluator", qftGrade: 5, parentId: "forged" });
  assert.equal(evaluator.authorId, "evaluator");
  assert.equal(evaluator.authorRole, "evaluator");
  assert.equal(evaluator.badge, "evaluator");
  assert.equal(evaluator.recommendation, "recommend_with_revisions");
  assert.equal(evaluator.qualifying, true);
  assert.equal(evaluator.parentId, null);
  assert.equal(db.records.get(`comments/${evaluator.id}`).qftGrade, null);
  assert.equal(db.records.get(`comments/${evaluator.id}`).parentId, null);
});

test("non-evaluators cannot spoof a recommendation; administrators are not assigned evaluators", async () => {
  const db = fixture();
  await assert.rejects(() => create(db, { recommendation: "recommend" }), { code: "invalid-argument" });
  const admin = await create(db, { uid: "admin", body: "Platform note only." });
  assert.equal(admin.authorRole, "administrator");
  assert.equal(admin.badge, null);
  assert.equal(admin.qualifying, false);
  await assert.rejects(() => create(db, { uid: "admin", recommendation: "recommend" }), { code: "invalid-argument" });
  assert.equal(comments(db).length, 1);
});

test("create rejects drafts, unreadable proposals, empty bodies and oversized text", async () => {
  const db = fixture();
  await assert.rejects(() => create(db, { proposalId: "draft" }), { code: "failed-precondition" });
  await assert.rejects(() => create(db, { proposalId: "missing" }), { code: "permission-denied" });
  await assert.rejects(() => create(db, { uid: "suspended" }), { code: "permission-denied" });
  await assert.rejects(() => create(db, { body: "   " }), { code: "invalid-argument" });
  await assert.rejects(() => create(db, { body: "x".repeat(COMMENT_BODY_MAX + 1) }), { code: "invalid-argument" });
  db.records.get("proposals/a").moderationStatus = "hidden";
  await assert.rejects(() => create(db, { uid: "funder" }), { code: "permission-denied" });
  assert.equal(comments(db).length, 0);
});

test("authors can edit within 15 minutes; later edits and other members are rejected", async () => {
  const db = fixture();
  const created = await create(db, { uid: "evaluator", recommendation: "recommend" });
  const edited = await editComment({ db, uid: "evaluator", commentId: created.id,
    body: "  Updated review with a citation.  ", now: later(COMMENT_EDIT_WINDOW_MS) });
  assert.equal(edited.body, "Updated review with a citation.");
  assert.equal(edited.recommendation, "recommend");
  assert.equal(edited.qualifying, true);
  assert.ok(edited.editedAt);
  assert.equal(db.records.get(`comments/${created.id}`).revisions[0].action, "edit");
  assert.equal(db.records.get(`comments/${created.id}`).revisions[0].body, "The claimed latency needs a cited benchmark.");

  await assert.rejects(() => editComment({ db, uid: "funder", commentId: created.id, body: "Hijack", now }),
    { code: "permission-denied" });
  await assert.rejects(() => editComment({ db, uid: "evaluator", commentId: created.id, body: "Too late",
    now: later(COMMENT_EDIT_WINDOW_MS + 1) }), { code: "failed-precondition" });
});

test("edit re-derives evaluator status and a demoted author loses the qualifying recommendation", async () => {
  const db = fixture();
  const created = await create(db, { uid: "evaluator", recommendation: "do_not_recommend" });
  db.records.get("users/evaluator").role = 0;
  await assert.rejects(() => editComment({ db, uid: "evaluator", commentId: created.id,
    body: "Now posting as a member.", recommendation: "recommend", now: later(1000) }), { code: "invalid-argument" });
  const edited = await editComment({ db, uid: "evaluator", commentId: created.id,
    body: "Now posting as a member.", now: later(1000) });
  assert.equal(edited.authorRole, "user");
  assert.equal(edited.badge, null);
  assert.equal(edited.recommendation, null);
  assert.equal(edited.qualifying, false);
});

test("authors can soft-delete anytime; listing hides the record and qualifying is cleared", async () => {
  const db = fixture();
  const created = await create(db, { uid: "evaluator", recommendation: "recommend" });
  await assert.rejects(() => deleteComment({ db, uid: "alice", commentId: created.id, now }),
    { code: "permission-denied" });
  const deleted = await deleteComment({ db, uid: "evaluator", commentId: created.id, now: later(COMMENT_EDIT_WINDOW_MS + 60_000) });
  assert.ok(deleted.deletedAt);
  assert.equal(deleted.qualifying, false);
  assert.equal(db.records.get(`comments/${created.id}`).deletedBy, "evaluator");
  assert.equal(db.records.get(`comments/${created.id}`).body, created.body);
  assert.equal(db.records.get(`comments/${created.id}`).revisions.at(-1).action, "delete");
  assert.equal((await listReportableComments({ db, uid: "funder", proposalId: "a" })).items.length, 0);
  const again = await deleteComment({ db, uid: "evaluator", commentId: created.id, now: later(9e7) });
  assert.equal(again.deletedAt, deleted.deletedAt);
  await assert.rejects(() => editComment({ db, uid: "evaluator", commentId: created.id, body: "Revive", now }),
    { code: "failed-precondition" });
});
