import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Timestamp } from "firebase-admin/firestore";
import { memoryDb } from "./memoryDb.mjs";
import {
  COMMENT_EDIT_WINDOW_MS,
  COMMENT_BODY_MAX,
  createComment,
  deleteComment,
  editComment,
  prepareCommentEvaluationGate,
} from "../comments.js";
import { listReportableComments, moderateContent } from "../moderation.js";
import { fundMockProposal, getMockMatching, selectMockProposal } from "../matching.js";

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
    "problems/problem": {
      ownerId: "owner",
      title: "Routing study",
      summary: "Improve routes",
      status: "submitted",
      createdAt: now,
    },
    "proposals/a": {
      researcherId: "alice",
      postingOwnerId: "owner",
      problemId: "problem",
      title: "Proposal A",
      summary: "A routing approach",
      status: "submitted",
      createdAt: now,
    },
    "proposals/draft": {
      researcherId: "alice",
      problemId: "problem",
      title: "Draft",
      status: "draft",
      createdAt: now,
    },
  });
}
const create = (db, patch = {}) =>
  createComment({
    db,
    uid: "funder",
    proposalId: "a",
    body: "The claimed latency needs a cited benchmark.",
    now,
    ...patch,
  });
const comments = (db) =>
  [...db.records.entries()].filter(([path]) => path.startsWith("comments/"));
function matchingReady(db) {
  Object.assign(db.records.get("problems/problem"), { currency: "SGD", status: "open" });
  Object.assign(db.records.get("proposals/a"), { amount: 100, currency: "SGD" });
  return db;
}

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
  assert.equal(
    db.records.get("proposals/a").matching?.evaluationComplete === true,
    false,
  );
  const stored = db.records.get(`comments/${member.id}`);
  assert.equal(stored.qftGrade, null);
  assert.equal(stored.qftGradedAt, null);
  assert.equal(stored.qftGradedBy, null);
  assert.equal(stored.authorId, "funder");

  await assert.rejects(() => create(db, { uid: "evaluator" }), {
    code: "invalid-argument",
  });
  await assert.rejects(
    () => create(db, { uid: "evaluator", recommendation: "approve" }),
    { code: "invalid-argument" },
  );
  const evaluator = await create(db, {
    uid: "evaluator",
    recommendation: "recommend_with_revisions",
    authorId: "alice",
    badge: "evaluator",
    qftGrade: 5,
  });
  assert.equal(evaluator.authorId, "evaluator");
  assert.equal(evaluator.authorRole, "evaluator");
  assert.equal(evaluator.badge, "evaluator");
  assert.equal(evaluator.recommendation, "recommend_with_revisions");
  assert.equal(evaluator.qualifying, true);
  assert.equal(evaluator.parentId, null);
  assert.equal(evaluator.replyCount, 0);
  assert.equal(db.records.get(`comments/${evaluator.id}`).qftGrade, null);
  assert.equal(db.records.get(`comments/${evaluator.id}`).parentId, null);
  assert.equal(db.records.get("proposals/a").matching.evaluationComplete, true);
  await assert.rejects(() => create(db, { parentId: "forged" }), { code: "not-found" });
});

test("members can reply once under a top-level comment; replies never qualify", async () => {
  const db = fixture();
  const parent = await create(db);
  assert.equal(parent.replyCount, 0);
  const reply = await create(db, { uid: "alice", body: "Agree on the benchmark.", parentId: parent.id });
  assert.equal(reply.parentId, parent.id);
  assert.equal(reply.qualifying, false);
  assert.equal(reply.recommendation, null);
  assert.equal(db.records.get(`comments/${parent.id}`).replyCount, 1);
  const evaluatorReply = await create(db, {
    uid: "evaluator",
    body: "Need the cited figure as well.",
    parentId: parent.id,
  });
  assert.equal(evaluatorReply.parentId, parent.id);
  assert.equal(evaluatorReply.qualifying, false);
  assert.equal(evaluatorReply.recommendation, null);
  assert.equal(evaluatorReply.badge, "evaluator");
  assert.equal(db.records.get(`comments/${parent.id}`).replyCount, 2);
  assert.equal(db.records.get("proposals/a").matching?.evaluationComplete === true, false);
  await assert.rejects(() => create(db, { parentId: reply.id, body: "Nested reply." }), {
    code: "failed-precondition",
  });
  await assert.rejects(
    () => create(db, { uid: "evaluator", parentId: parent.id, recommendation: "recommend", body: "Spoof." }),
    { code: "invalid-argument" },
  );
});

test("listing resolves public names, recommendation fields and newest-first order", async () => {
  const db = fixture();
  db.records.set("publicProfiles/funder", { fullName: "Funder" });
  db.records.set("publicProfiles/evaluator", { fullName: "Assigned evaluator" });
  db.records.set("publicProfiles/alice", { fullName: "Alice" });
  const member = await create(db);
  const evaluator = await create(db, { uid: "evaluator", recommendation: "recommend",
    body: "Evaluator view.", now: later(1000) });
  const reply = await create(db, { uid: "alice", body: "Need the cited figure.", parentId: member.id, now: later(2000) });
  const oldest = await listReportableComments({ db, uid: "funder", proposalId: "a" });
  assert.equal(oldest.items.length, 2);
  assert.equal(oldest.items[0].id, member.id);
  assert.equal(oldest.items[0].authorName, "Funder");
  assert.equal(oldest.items[0].parentId, null);
  assert.equal(oldest.items[0].replyCount, 1);
  assert.equal(oldest.items[0].replies.length, 1);
  assert.equal(oldest.items[0].replies[0].id, reply.id);
  assert.equal(oldest.items[0].replies[0].parentId, member.id);
  assert.equal(oldest.items[0].replies[0].authorName, "Alice");
  assert.equal(oldest.items[1].authorName, "Assigned evaluator");
  assert.equal(oldest.items[1].qualifying, true);
  assert.equal(oldest.items[1].recommendation, "recommend");
  assert.deepEqual(oldest.items[1].replies, []);
  assert.equal(oldest.items.some((item) => item.id === reply.id), false);
  const newest = await listReportableComments({ db, uid: "funder", proposalId: "a", sort: "newest" });
  assert.equal(newest.items.map((item) => item.id).join(","), `${evaluator.id},${member.id}`);
  assert.equal(newest.items.find((item) => item.id === member.id).replies[0].id, reply.id);
  await assert.rejects(() => listReportableComments({ db, uid: "funder", proposalId: "a", sort: "popular" }),
    { code: "invalid-argument" });
});

test("non-evaluators cannot spoof a recommendation; administrators are not assigned evaluators", async () => {
  const db = fixture();
  await assert.rejects(() => create(db, { recommendation: "recommend" }), {
    code: "invalid-argument",
  });
  const admin = await create(db, { uid: "admin", body: "Platform note only." });
  assert.equal(admin.authorRole, "administrator");
  assert.equal(admin.badge, null);
  assert.equal(admin.qualifying, false);
  await assert.rejects(
    () => create(db, { uid: "admin", recommendation: "recommend" }),
    { code: "invalid-argument" },
  );
  assert.equal(comments(db).length, 1);
});

test("create rejects drafts, unreadable proposals, empty bodies and oversized text", async () => {
  const db = fixture();
  await assert.rejects(() => create(db, { proposalId: "draft" }), {
    code: "failed-precondition",
  });
  await assert.rejects(() => create(db, { proposalId: "missing" }), {
    code: "permission-denied",
  });
  await assert.rejects(() => create(db, { uid: "suspended" }), {
    code: "permission-denied",
  });
  await assert.rejects(() => create(db, { body: "   " }), {
    code: "invalid-argument",
  });
  await assert.rejects(
    () => create(db, { body: "x".repeat(COMMENT_BODY_MAX + 1) }),
    { code: "invalid-argument" },
  );
  db.records.get("proposals/a").moderationStatus = "hidden";
  await assert.rejects(() => create(db, { uid: "funder" }), {
    code: "permission-denied",
  });
  assert.equal(comments(db).length, 0);
});

test("authors can edit within 15 minutes; later edits and other members are rejected", async () => {
  const db = fixture();
  const created = await create(db, {
    uid: "evaluator",
    recommendation: "recommend",
  });
  const edited = await editComment({
    db,
    uid: "evaluator",
    commentId: created.id,
    body: "  Updated review with a citation.  ",
    now: later(COMMENT_EDIT_WINDOW_MS),
  });
  assert.equal(edited.body, "Updated review with a citation.");
  assert.equal(edited.recommendation, "recommend");
  assert.equal(edited.qualifying, true);
  assert.ok(edited.editedAt);
  assert.equal(
    db.records.get(`comments/${created.id}`).revisions[0].action,
    "edit",
  );
  assert.equal(
    db.records.get(`comments/${created.id}`).revisions[0].body,
    "The claimed latency needs a cited benchmark.",
  );

  await assert.rejects(
    () =>
      editComment({
        db,
        uid: "funder",
        commentId: created.id,
        body: "Hijack",
        now,
      }),
    { code: "permission-denied" },
  );
  await assert.rejects(
    () =>
      editComment({
        db,
        uid: "evaluator",
        commentId: created.id,
        body: "Too late",
        now: later(COMMENT_EDIT_WINDOW_MS + 1),
      }),
    { code: "failed-precondition" },
  );
});

test("edit re-derives evaluator status and a demoted author loses the qualifying recommendation", async () => {
  const db = fixture();
  const created = await create(db, {
    uid: "evaluator",
    recommendation: "do_not_recommend",
  });
  db.records.get("users/evaluator").role = 0;
  await assert.rejects(
    () =>
      editComment({
        db,
        uid: "evaluator",
        commentId: created.id,
        body: "Now posting as a member.",
        recommendation: "recommend",
        now: later(1000),
      }),
    { code: "invalid-argument" },
  );
  const edited = await editComment({
    db,
    uid: "evaluator",
    commentId: created.id,
    body: "Now posting as a member.",
    now: later(1000),
  });
  assert.equal(edited.authorRole, "user");
  assert.equal(edited.badge, null);
  assert.equal(edited.recommendation, null);
  assert.equal(edited.qualifying, false);
  assert.equal(
    db.records.get("proposals/a").matching.evaluationComplete,
    false,
  );
});

test("authors can soft-delete anytime; listing hides the record and qualifying is cleared", async () => {
  const db = fixture();
  const created = await create(db, {
    uid: "evaluator",
    recommendation: "recommend",
  });
  await assert.rejects(
    () => deleteComment({ db, uid: "alice", commentId: created.id, now }),
    { code: "permission-denied" },
  );
  const deleted = await deleteComment({
    db,
    uid: "evaluator",
    commentId: created.id,
    now: later(COMMENT_EDIT_WINDOW_MS + 60_000),
  });
  assert.ok(deleted.deletedAt);
  assert.equal(deleted.qualifying, false);
  assert.equal(db.records.get(`comments/${created.id}`).deletedBy, "evaluator");
  assert.equal(db.records.get(`comments/${created.id}`).body, created.body);
  assert.equal(
    db.records.get(`comments/${created.id}`).revisions.at(-1).action,
    "delete",
  );
  assert.equal(
    (await listReportableComments({ db, uid: "funder", proposalId: "a" })).items
      .length,
    0,
  );
  const again = await deleteComment({
    db,
    uid: "evaluator",
    commentId: created.id,
    now: later(9e7),
  });
  assert.equal(again.deletedAt, deleted.deletedAt);
  await assert.rejects(
    () =>
      editComment({
        db,
        uid: "evaluator",
        commentId: created.id,
        body: "Revive",
        now,
      }),
    { code: "failed-precondition" },
  );
});

test("deleting a parent with replies keeps a placeholder; deleting the last reply drops the thread", async () => {
  const db = fixture();
  db.records.set("publicProfiles/funder", { fullName: "Funder" });
  db.records.set("publicProfiles/alice", { fullName: "Alice" });
  const parent = await create(db);
  const reply = await create(db, { uid: "alice", body: "Agree on the benchmark.", parentId: parent.id });
  await deleteComment({ db, uid: "funder", commentId: parent.id, now: later(1000) });
  const listed = await listReportableComments({ db, uid: "funder", proposalId: "a" });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].id, parent.id);
  assert.equal(listed.items[0].deleted, true);
  assert.equal(listed.items[0].body, "");
  assert.equal(listed.items[0].authorName, "");
  assert.equal(listed.items[0].replyCount, 1);
  assert.equal(listed.items[0].replies.length, 1);
  assert.equal(listed.items[0].replies[0].id, reply.id);
  assert.equal(listed.items[0].replies[0].body, "Agree on the benchmark.");
  const extra = await create(db, { uid: "alice", body: "Still on this thread.", parentId: parent.id, now: later(2000) });
  assert.equal(extra.parentId, parent.id);
  assert.equal(db.records.get(`comments/${parent.id}`).replyCount, 2);
  await deleteComment({ db, uid: "alice", commentId: reply.id, now: later(3000) });
  assert.equal(db.records.get(`comments/${parent.id}`).replyCount, 1);
  assert.equal((await listReportableComments({ db, uid: "funder", proposalId: "a" })).items[0].replies.length, 1);
  await deleteComment({ db, uid: "alice", commentId: extra.id, now: later(4000) });
  assert.equal(db.records.get(`comments/${parent.id}`).replyCount, 0);
  assert.equal((await listReportableComments({ db, uid: "funder", proposalId: "a" })).items.length, 0);
});

test("evaluationComplete stays true while any qualifying comment remains and clears when the last one is removed", async () => {
  const db = fixture();
  const first = await create(db, {
    uid: "evaluator",
    recommendation: "recommend",
  });
  const second = await create(db, {
    uid: "evaluator",
    recommendation: "do_not_recommend",
    body: "A second independent recommendation.",
  });
  assert.equal(db.records.get("proposals/a").matching.evaluationComplete, true);
  await deleteComment({
    db,
    uid: "evaluator",
    commentId: first.id,
    now: later(1000),
  });
  assert.equal(db.records.get("proposals/a").matching.evaluationComplete, true);
  await deleteComment({
    db,
    uid: "evaluator",
    commentId: second.id,
    now: later(2000),
  });
  assert.equal(
    db.records.get("proposals/a").matching.evaluationComplete,
    false,
  );
});

test("admin mock evaluationComplete survives deleting the last qualifying comment", async () => {
  const db = fixture();
  db.records.get("proposals/a").matching = {
    evaluationComplete: true,
    evaluationMockComplete: true,
    evaluationCompletedBy: "admin",
  };
  const created = await create(db, {
    uid: "evaluator",
    recommendation: "recommend",
  });
  await deleteComment({
    db,
    uid: "evaluator",
    commentId: created.id,
    now: later(1000),
  });
  assert.equal(db.records.get("proposals/a").matching.evaluationComplete, true);
  assert.equal(
    db.records.get("proposals/a").matching.evaluationMockComplete,
    true,
  );
});

test("hiding the last qualifying comment clears the gate; restore revalidates it", async () => {
  const db = fixture();
  const created = await create(db, {
    uid: "evaluator",
    recommendation: "recommend",
  });
  db.records.set(`moderationQueue/comment_${created.id}`, {
    contentType: "comment",
    contentId: created.id,
    status: "pending",
  });
  const act = (action, reason) =>
    moderateContent({
      db,
      uid: "admin",
      queueId: `comment_${created.id}`,
      action,
      reason,
      now,
      prepareCommentGate: prepareCommentEvaluationGate,
    });
  await act("hide", "off_topic");
  assert.equal(db.records.get(`comments/${created.id}`).qualifying, false);
  assert.equal(
    db.records.get("proposals/a").matching.evaluationComplete,
    false,
  );
  await act("restore", "no_violation");
  assert.equal(db.records.get(`comments/${created.id}`).qualifying, true);
  assert.equal(db.records.get("proposals/a").matching.evaluationComplete, true);
});

test("[BUT-SPER-23] recommendations stay advisory and never select, reject, score, or reorder proposals", async () => {
  const matchingSource = readFileSync(new URL("../matching.js", import.meta.url), "utf8");
  assert.equal(matchingSource.includes("recommendation"), false);
  const db = matchingReady(fixture());
  db.records.set("proposals/b", {
    researcherId: "alice",
    postingOwnerId: "owner",
    problemId: "problem",
    title: "Proposal B",
    status: "submitted",
    amount: 100,
    currency: "SGD",
    createdAt: now,
  });
  await create(db, { uid: "evaluator", recommendation: "do_not_recommend" });
  await create(db, {
    uid: "evaluator",
    proposalId: "b",
    recommendation: "recommend",
    body: "A stronger independent recommendation.",
  });
  const rejected = db.records.get("proposals/a");
  const endorsed = db.records.get("proposals/b");
  assert.equal(rejected.status, "submitted");
  assert.equal(endorsed.status, "submitted");
  assert.equal(rejected.matching.evaluationComplete, true);
  assert.equal(endorsed.matching.evaluationComplete, true);
  assert.equal(rejected.matching.status, undefined);
  assert.equal(endorsed.matching.status, undefined);
  assert.equal(db.records.get("problems/problem").acceptedProposalId, undefined);
  const view = await getMockMatching({ db, uid: "owner", problemId: "problem", now });
  assert.deepEqual(view.proposals.map((item) => item.id), ["a", "b"]);
  assert.equal(view.matching.status, "open");
  assert.equal(view.matching.proposalId, null);
  assert.ok(view.proposals.every((item) => item.canSelect === false));
});

test("[BUT-SPER-24] a qualifying evaluator comment does not unlock selection while funding is short", async () => {
  const db = matchingReady(fixture());
  await create(db, { uid: "evaluator", recommendation: "recommend" });
  assert.equal(db.records.get("proposals/a").matching.evaluationComplete, true);
  await fundMockProposal({
    db,
    uid: "funder",
    problemId: "problem",
    proposalId: "a",
    amount: 40,
    requestId: "request_short_fund",
    now,
  });
  const view = await getMockMatching({ db, uid: "owner", problemId: "problem", now });
  assert.equal(view.proposals.find((item) => item.id === "a").canSelect, false);
  await assert.rejects(
    () =>
      selectMockProposal({
        db,
        uid: "owner",
        problemId: "problem",
        proposalId: "a",
        rationale: "This approach meets our requirements.",
        now,
      }),
    { code: "failed-precondition", message: "Select a fully funded, active proposal." },
  );
  assert.equal(db.records.get("problems/problem").matching?.status || "open", "open");
  assert.equal(db.records.get("proposals/a").matching.status, "funding");
});

test("[BUT-SPER-25] removing one qualifying comment keeps the gate; removing the last clears it", async () => {
  const db = fixture();
  const first = await create(db, { uid: "evaluator", recommendation: "recommend" });
  const second = await create(db, {
    uid: "evaluator",
    recommendation: "do_not_recommend",
    body: "A second independent recommendation.",
  });
  const queue = (id) => {
    db.records.set(`moderationQueue/comment_${id}`, {
      contentType: "comment",
      contentId: id,
      status: "pending",
    });
  };
  queue(first.id);
  queue(second.id);
  const act = (id, action, reason) =>
    moderateContent({
      db,
      uid: "admin",
      queueId: `comment_${id}`,
      action,
      reason,
      now,
      prepareCommentGate: prepareCommentEvaluationGate,
    });
  await act(first.id, "remove", "off_topic");
  assert.equal(db.records.get(`comments/${first.id}`).qualifying, false);
  assert.equal(db.records.get("proposals/a").matching.evaluationComplete, true);
  await act(second.id, "remove", "off_topic");
  assert.equal(db.records.get(`comments/${second.id}`).qualifying, false);
  assert.equal(db.records.get("proposals/a").matching.evaluationComplete, false);
  await act(second.id, "restore", "no_violation");
  assert.equal(db.records.get(`comments/${second.id}`).qualifying, true);
  assert.equal(db.records.get("proposals/a").matching.evaluationComplete, true);
});

test("[BUT-SPER-26] evaluator comments stay off-chain and never write audit or matching history", async () => {
  const commentsSource = readFileSync(new URL("../comments.js", import.meta.url), "utf8");
  assert.equal(/viem|auditRegistry|writeContract/.test(commentsSource), false);
  const db = fixture();
  const created = await create(db, {
    uid: "evaluator",
    recommendation: "recommend",
    body: "Advisory review stays off-chain.",
  });
  const stored = db.records.get(`comments/${created.id}`);
  assert.equal(stored.body, "Advisory review stays off-chain.");
  assert.equal(stored.recommendation, "recommend");
  assert.equal(stored.transactionHash, undefined);
  assert.equal(stored.chainStatus, undefined);
  assert.equal(db.records.get("proposals/a").audit, undefined);
  assert.equal(db.records.get("proposals/a").matching.evaluationComplete, true);
  assert.equal(
    [...db.records.keys()].some((path) => path.startsWith("matchingEvents/")),
    false,
  );
});
