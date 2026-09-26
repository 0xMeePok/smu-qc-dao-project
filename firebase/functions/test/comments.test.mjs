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
import { listEvaluatorQueue, listMyProposals } from "../proposalQueues.js";
import { REPLIES_PER_MEMBER_PER_THREAD, REPLIES_PER_THREAD } from "../comments.js";

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

test("the gate follows the one recommendation a solution carries, and frees the slot when it goes", async () => {
  const db = fixture();
  db.records.set("users/evaluator2", { role: 2, fullName: "Second evaluator" });
  const first = await create(db, { uid: "evaluator", recommendation: "recommend" });
  assert.equal(db.records.get("proposals/a").matching.evaluationComplete, true);
  assert.equal(db.records.get("proposals/a").matching.recommendedBy, "evaluator");

  // A solution carries one recommendation: a second evaluator is refused.
  await assert.rejects(() => create(db, {
    uid: "evaluator2", recommendation: "do_not_recommend", body: "A competing recommendation.",
  }), { code: "failed-precondition" });

  await deleteComment({ db, uid: "evaluator", commentId: first.id, now: later(1000) });
  assert.equal(db.records.get("proposals/a").matching.evaluationComplete, false);
  assert.equal(db.records.get("proposals/a").matching.recommendedBy, null);

  // With the slot free another evaluator may take it.
  const second = await create(db, {
    uid: "evaluator2", recommendation: "do_not_recommend", body: "A later recommendation.", now: later(2000),
  });
  assert.equal(db.records.get("proposals/a").matching.recommendedBy, "evaluator2");
  await deleteComment({ db, uid: "evaluator2", commentId: second.id, now: later(3000) });
  assert.equal(db.records.get("proposals/a").matching.evaluationComplete, false);
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

test("[BUT-SPER-25] removing the recommendation clears the gate; restoring it brings the gate back", async () => {
  const db = fixture();
  const only = await create(db, { uid: "evaluator", recommendation: "recommend" });
  db.records.set(`moderationQueue/comment_${only.id}`, {
    contentType: "comment",
    contentId: only.id,
    status: "pending",
  });
  const act = (action, reason) =>
    moderateContent({
      db,
      uid: "admin",
      queueId: `comment_${only.id}`,
      action,
      reason,
      now,
      prepareCommentGate: prepareCommentEvaluationGate,
    });
  await act("remove", "off_topic");
  assert.equal(db.records.get(`comments/${only.id}`).qualifying, false);
  assert.equal(db.records.get("proposals/a").matching.evaluationComplete, false);
  assert.equal(db.records.get("proposals/a").matching.recommendedBy, null);
  await act("restore", "no_violation");
  assert.equal(db.records.get(`comments/${only.id}`).qualifying, true);
  assert.equal(db.records.get("proposals/a").matching.evaluationComplete, true);
  assert.equal(db.records.get("proposals/a").matching.recommendedBy, "evaluator");
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
  assert.equal(
    [...db.records.keys()].some((path) => path.includes("/ownerReviews/") || path.includes("/ownerReviewLatest/")),
    false,
  );
});

/** QCDAO-62/63 - the tracking list and the evaluator queue, built from these same records. */
const DAY = 24 * 60 * 60 * 1000;

function queueFixture(overrides = {}) {
  return memoryDb({
    "users/owner": { role: 0, fullName: "Problem owner" },
    "users/alice": { role: 0, fullName: "Alice" },
    "users/evaluator": { role: 2, fullName: "Assigned evaluator" },
    "problems/soon": { ownerId: "owner", title: "Closing soon", status: "open", expiresAt: later(2 * DAY), createdAt: now },
    "problems/later": { ownerId: "owner", title: "Closing later", status: "submitted", expiresAt: later(9 * DAY), createdAt: now },
    "problems/unpublished": { ownerId: "owner", title: "Draft posting", status: "draft", expiresAt: later(DAY), createdAt: now },
    "proposals/soon-a": { researcherId: "alice", postingOwnerId: "owner", problemId: "soon", title: "Soon solution",
      status: "submitted", amount: 100, currency: "SGD", createdAt: now },
    "proposals/later-a": { researcherId: "alice", postingOwnerId: "owner", problemId: "later", title: "Later solution",
      status: "submitted", amount: 200, currency: "SGD", createdAt: later(60_000) },
    "proposals/evaluator-own": { researcherId: "evaluator", postingOwnerId: "owner", problemId: "later",
      title: "The evaluator's own solution", status: "submitted", createdAt: now },
    "proposals/unpublished-a": { researcherId: "alice", postingOwnerId: "owner", problemId: "unpublished",
      title: "On an unpublished posting", status: "submitted", createdAt: now },
    ...overrides,
  });
}

test("shows the parent posting's pending match to researchers and evaluators without its private details", async () => {
  const deadlineAt = later(2 * DAY);
  const db = queueFixture({
    "problems/later": { ownerId: "owner", title: "Closing later", status: "submitted", expiresAt: later(9 * DAY), createdAt: now,
      matching: { status: "awaiting_confirmation", deadlineAt, proposalId: "later-a", totalFundedMinor: 50_000, approvals: { a: true } } },
  });
  const mine = (await listMyProposals({ db, uid: "alice" })).items;
  assert.deepEqual(mine.find((item) => item.id === "later-a").posting.matching, {
    status: "awaiting_confirmation", deadlineAt: deadlineAt.toDate().toISOString(), confirmedAt: null,
  });
  // A posting with no match, or one still collecting funding, carries none.
  assert.equal(mine.find((item) => item.id === "soon-a").posting.matching, null);
  const queue = (await listEvaluatorQueue({ db, uid: "evaluator", filter: "pending" })).items;
  const onLater = queue.find((item) => item.posting.id === "later");
  assert.deepEqual(Object.keys(onLater.posting.matching).sort(), ["confirmedAt", "deadlineAt", "status"]);
});

test("[QCDAO-62] tracks my proposals with their posting, comment count and recommendation progress", async () => {
  const db = queueFixture();
  await createComment({ db, uid: "owner", proposalId: "soon-a", body: "How does this scale?", now });
  await createComment({ db, uid: "evaluator", proposalId: "soon-a", body: "Sound approach", recommendation: "recommend", now });
  const { items } = await listMyProposals({ db, uid: "alice" });
  assert.ok(!items.some((item) => item.id === "evaluator-own"), "another member's proposal must not appear");
  const soon = items.find((item) => item.id === "soon-a");
  assert.equal(soon.posting.title, "Closing soon");
  assert.equal(soon.posting.expiresAt, later(2 * DAY).toDate().toISOString());
  assert.equal(soon.comments, 2);
  assert.equal(soon.qualifying, 1);
  assert.deepEqual(soon.recommendations, ["recommend"]);
  assert.equal(soon.evaluationComplete, true);
  assert.equal(items.find((item) => item.id === "later-a").qualifying, 0);
});

test("[QCDAO-62] counts only the comments a reader can still see", async () => {
  const db = queueFixture();
  const removed = await createComment({ db, uid: "owner", proposalId: "soon-a", body: "Withdrawn question", now });
  await createComment({ db, uid: "owner", proposalId: "soon-a", body: "Standing question", now });
  await deleteComment({ db, uid: "owner", commentId: removed.id, now: later(1000) });
  const { items } = await listMyProposals({ db, uid: "alice" });
  assert.equal(items.find((item) => item.id === "soon-a").comments, 1);
});

test("[QCDAO-63] refuses the queue to an account without the evaluator access level", async () => {
  const db = queueFixture();
  await assert.rejects(() => listEvaluatorQueue({ db, uid: "alice" }), /assigned evaluator/);
});

test("[QCDAO-63] queues eligible solutions closing soonest, skipping the evaluator's own and unpublished postings", async () => {
  const db = queueFixture();
  const { items } = await listEvaluatorQueue({ db, uid: "evaluator", filter: "pending" });
  assert.deepEqual(items.map((item) => item.id), ["soon-a", "later-a"]);
  assert.equal(items[0].posting.title, "Closing soon");
  assert.equal(items[0].recommendationStatus, "pending");
});

test("[QCDAO-63] separates pending from submitted once my recommendation is filed", async () => {
  const db = queueFixture();
  await createComment({ db, uid: "evaluator", proposalId: "soon-a", body: "Strong fit", recommendation: "recommend_with_revisions", now });
  const pending = await listEvaluatorQueue({ db, uid: "evaluator", filter: "pending" });
  assert.deepEqual(pending.items.map((item) => item.id), ["later-a"]);
  const submitted = await listEvaluatorQueue({ db, uid: "evaluator", filter: "submitted" });
  assert.deepEqual(submitted.items.map((item) => item.id), ["soon-a"]);
  assert.equal(submitted.items[0].recommendation, "recommend_with_revisions");
});

test("[QCDAO-63] a reply from me is not a recommendation and leaves the solution pending", async () => {
  const db = queueFixture();
  const parent = await createComment({ db, uid: "owner", proposalId: "soon-a", body: "Question for the team", now });
  await createComment({ db, uid: "evaluator", proposalId: "soon-a", body: "Answering the question", parentId: parent.id, now });
  const { items } = await listEvaluatorQueue({ db, uid: "evaluator", filter: "pending" });
  assert.ok(items.some((item) => item.id === "soon-a"));
});

/** Bounded discussions: replies are capped when posted and paged when read. */
test("a member cannot post unbounded replies under one comment", async () => {
  const db = fixture();
  const parent = await create(db);
  for (let index = 0; index < REPLIES_PER_MEMBER_PER_THREAD; index += 1) {
    await createComment({ db, uid: "alice", proposalId: "a", parentId: parent.id, body: `Reply ${index}`, now });
  }
  await assert.rejects(
    () => createComment({ db, uid: "alice", proposalId: "a", parentId: parent.id, body: "One too many", now }),
    { code: "resource-exhausted" },
  );
  // A different member still has their own allowance.
  await assert.doesNotReject(
    () => createComment({ db, uid: "owner", proposalId: "a", parentId: parent.id, body: "A separate voice", now }),
  );
});

test("a thread stops accepting replies at its cap", async () => {
  const db = fixture();
  const parent = await create(db);
  db.records.set(`comments/${parent.id}`, { ...db.records.get(`comments/${parent.id}`), replyCount: REPLIES_PER_THREAD });
  await assert.rejects(
    () => createComment({ db, uid: "owner", proposalId: "a", parentId: parent.id, body: "Past the cap", now }),
    { code: "resource-exhausted" },
  );
});

test("a long thread returns a bounded preview and pages the rest through a cursor", async () => {
  const db = fixture();
  const parent = await create(db);
  for (let index = 0; index < 8; index += 1) {
    await createComment({ db, uid: index % 2 ? "alice" : "owner", proposalId: "a", parentId: parent.id,
      body: `Reply ${index}`, now: later(index + 1) });
  }
  const listed = await listReportableComments({ db, uid: "owner", problemId: "problem", proposalId: "a" });
  const thread = listed.items.find((item) => item.id === parent.id);
  assert.equal(thread.replyCount, 8);
  assert.ok(thread.replies.length < 8, "the first response must not carry every reply");
  assert.equal(thread.hasMoreReplies, true);
  assert.ok(thread.nextReplyCursor);

  const page = await listReportableComments({ db, uid: "owner", problemId: "problem", proposalId: "a",
    threadId: parent.id, cursor: thread.nextReplyCursor });
  assert.equal(page.threadId, parent.id);
  assert.ok(page.items.length > 0);
  const seen = new Set([...thread.replies, ...page.items].map((item) => item.id));
  assert.equal(seen.size, thread.replies.length + page.items.length, "pages must not repeat a reply");
  assert.ok(page.items.every((item) => item.parentId === parent.id));
});

test("thread paging refuses a comment that belongs to another proposal", async () => {
  const db = fixture();
  const parent = await create(db);
  db.records.set(`proposals/other`, { researcherId: "alice", postingOwnerId: "owner", problemId: "problem",
    title: "Other", status: "submitted", createdAt: now });
  await assert.rejects(
    () => listReportableComments({ db, uid: "owner", problemId: "problem", proposalId: "other", threadId: parent.id }),
    { code: "not-found" },
  );
});

/** One recommendation per solution, never from its author. */
test("an evaluator may discuss their own solution but never recommend it", async () => {
  const db = fixture();
  db.records.set("proposals/own", {
    researcherId: "evaluator", postingOwnerId: "owner", problemId: "problem",
    title: "The evaluator's own solution", status: "submitted", createdAt: now,
  });
  await assert.rejects(() => createComment({
    db, uid: "evaluator", proposalId: "own", body: "Backing my own work.", recommendation: "recommend", now,
  }), { code: "permission-denied" });

  // Discussion is still open to them; it simply carries no recommendation.
  const plain = await createComment({ db, uid: "evaluator", proposalId: "own", body: "Clarifying my approach.", now });
  assert.equal(plain.recommendation, null);
  assert.equal(plain.qualifying, false);
  assert.equal(db.records.get("proposals/own").matching?.evaluationComplete === true, false);
  assert.equal(db.records.get("proposals/own").matching?.recommendedBy ?? null, null);
});

test("two evaluators recommending at once leave exactly one recommendation on record", async () => {
  const db = fixture();
  db.records.set("users/evaluator2", { role: 2, fullName: "Second evaluator" });
  const outcomes = await Promise.allSettled([
    createComment({ db, uid: "evaluator", proposalId: "a", body: "The first view.", recommendation: "recommend", now }),
    createComment({ db, uid: "evaluator2", proposalId: "a", body: "The second view.", recommendation: "do_not_recommend", now }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const refused = outcomes.find((outcome) => outcome.status === "rejected");
  assert.equal(refused.reason.code, "failed-precondition");
  assert.match(refused.reason.message, /already recommended/i);
  const qualifying = comments(db).filter(([, data]) => data.qualifying === true);
  assert.equal(qualifying.length, 1);
  assert.equal(db.records.get("proposals/a").matching.recommendedBy, qualifying[0][1].authorId);
});

test("[QCDAO-63] drops a solution from every queue once any evaluator has recommended it", async () => {
  const db = queueFixture();
  db.records.set("users/evaluator2", { role: 2, fullName: "Second evaluator" });
  await createComment({ db, uid: "evaluator2", proposalId: "soon-a", body: "A sound approach.", recommendation: "recommend", now });

  const pending = await listEvaluatorQueue({ db, uid: "evaluator", filter: "pending" });
  assert.deepEqual(pending.items.map((item) => item.id), ["later-a"], "someone else's call is not mine to make");
  const submitted = await listEvaluatorQueue({ db, uid: "evaluator", filter: "submitted" });
  assert.deepEqual(submitted.items.map((item) => item.id), []);

  const theirs = await listEvaluatorQueue({ db, uid: "evaluator2", filter: "submitted" });
  assert.deepEqual(theirs.items.map((item) => item.id), ["soon-a"]);
  assert.equal(theirs.items[0].recommendation, "recommend");
});
