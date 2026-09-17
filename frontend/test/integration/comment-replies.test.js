import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { ROLES } from "../../src/config/roles.js";
import { memoryDb } from "../../../firebase/functions/test/memoryDb.mjs";
import { createComment, deleteComment } from "../../../firebase/functions/comments.js";
import { listReportableComments } from "../../../firebase/functions/moderation.js";

/** QCDAO-70 - reply to comments in a threaded discussion. */

const require = createRequire(new URL("../../../firebase/functions/package.json", import.meta.url));
const { Timestamp } = require("firebase-admin/firestore");
const now = Timestamp.fromMillis(1_800_000_000_000);
const later = (ms) => Timestamp.fromMillis(now.toMillis() + ms);

function fixture() {
  return memoryDb({
    "users/alice": { role: 0, fullName: "Alice" },
    "users/funder": { role: 0, fullName: "Funder" },
    "users/evaluator": { role: 2, fullName: "Assigned evaluator" },
    "publicProfiles/alice": { fullName: "Alice" },
    "publicProfiles/funder": { fullName: "Funder" },
    "publicProfiles/evaluator": { fullName: "Assigned evaluator" },
    "problems/problem": {
      ownerId: "alice",
      title: "Routing study",
      summary: "Improve routes",
      status: "submitted",
      createdAt: now,
    },
    "proposals/a": {
      researcherId: "alice",
      postingOwnerId: "alice",
      problemId: "problem",
      title: "Proposal A",
      summary: "A routing approach",
      status: "submitted",
      createdAt: now,
    },
  });
}

const MEMBER = { id: "funder", roles: [ROLES.FUNDER] };
const EVALUATOR = { id: "evaluator", roles: [ROLES.EVALUATOR] };

const create = (db, patch = {}) =>
  createComment({
    db,
    uid: "funder",
    proposalId: "a",
    body: "The claimed latency needs a cited benchmark.",
    now,
    ...patch,
  });

function isEvaluator(user) {
  return Boolean(user?.roles?.includes(ROLES.EVALUATOR));
}

function sameAuthor(user, item) {
  return Boolean(user?.id && item?.authorId && user.id.toLowerCase() === item.authorId.toLowerCase());
}

function canEditComment(item, clock = Date.now()) {
  const created = item?.createdAt ? new Date(item.createdAt) : null;
  return Boolean(created) && !Number.isNaN(created.getTime())
    && clock - created.getTime() <= 15 * 60 * 1000;
}

/** Mirrors ReportableComments after a listReportableComments response. */
function threadView({ listed, user, proposalId, expandedIds = new Set() }) {
  const canCompose = Boolean(user?.id && proposalId);
  return {
    canCompose,
    showTopLevelRecommendation: canCompose && isEvaluator(user),
    comments: (listed.items ?? []).map((item) => {
      const removed = Boolean(item.deleted || item.deletedAt);
      const parent = !item.parentId;
      const expanded = expandedIds.has(item.id);
      const count = item.replyCount ?? item.replies?.length ?? 0;
      const replies = item.replies || [];
      return {
        id: item.id,
        body: removed ? "This comment was removed" : item.body,
        removed,
        authorName: removed ? "" : item.authorName,
        showEdit: !removed && sameAuthor(user, item) && canEditComment(item),
        showDelete: !removed && sameAuthor(user, item),
        showReport: !removed,
        showReply: parent && canCompose,
        showToggle: parent && count > 0,
        toggleLabel: expanded
          ? "Hide replies"
          : count === 1 ? "Show 1 reply" : `Show ${count} replies`,
        visibleReplies: expanded ? replies : [],
        nestedCanReply: false,
        showReplyComposer: parent && expanded && canCompose,
        replyPayload: parent && expanded && canCompose
          ? { proposalId, parentId: item.id }
          : null,
        replyRequiresRecommendation: false,
      };
    }),
  };
}

describe("[QCDAO-70] reply to comments in a threaded discussion", () => {
  it("[FIT-SCR-042] should let a member reply on a solution and list that reply under the parent", async () => {
    const db = fixture();
    const parent = await create(db);
    const reply = await create(db, { uid: "alice", body: "Agree on the benchmark.", parentId: parent.id });
    const listed = await listReportableComments({ db, uid: "funder", proposalId: "a", problemId: "problem" });
    const view = threadView({ listed, user: MEMBER, proposalId: "a" });
    assert.equal(view.canCompose, true);
    assert.equal(view.comments.length, 1);
    assert.equal(view.comments[0].id, parent.id);
    assert.equal(view.comments[0].showReply, true);
    assert.equal(view.comments[0].showToggle, true);
    assert.equal(view.comments[0].toggleLabel, "Show 1 reply");
    assert.equal(view.comments[0].visibleReplies.length, 0);
    assert.equal(listed.items[0].replies[0].id, reply.id);
    assert.equal(listed.items[0].replies[0].parentId, parent.id);
  });

  it("[FIT-SCR-043] should require an evaluator recommendation only on a top-level comment, not a reply", async () => {
    const db = fixture();
    await assert.rejects(() => create(db, { uid: "evaluator" }), { code: "invalid-argument" });
    const parent = await create(db, { uid: "evaluator", recommendation: "recommend" });
    const reply = await create(db, {
      uid: "evaluator",
      body: "Need the cited figure as well.",
      parentId: parent.id,
    });
    const listed = await listReportableComments({ db, uid: "evaluator", proposalId: "a" });
    const view = threadView({
      listed, user: EVALUATOR, proposalId: "a", expandedIds: new Set([parent.id]),
    });
    assert.equal(parent.qualifying, true);
    assert.equal(reply.qualifying, false);
    assert.equal(reply.recommendation, null);
    assert.equal(view.showTopLevelRecommendation, true);
    assert.equal(view.comments[0].replyRequiresRecommendation, false);
    assert.equal(view.comments[0].replyPayload.parentId, parent.id);
    assert.equal(view.comments[0].visibleReplies[0].id, reply.id);
  });

  it("[FIT-SCR-044] should keep replies collapsed until expanded, then offer a reply composer on the parent", async () => {
    const db = fixture();
    const parent = await create(db);
    await create(db, { uid: "alice", body: "Agree on the benchmark.", parentId: parent.id });
    const listed = await listReportableComments({ db, uid: "funder", proposalId: "a" });
    const collapsed = threadView({ listed, user: MEMBER, proposalId: "a" });
    assert.equal(collapsed.comments[0].visibleReplies.length, 0);
    assert.equal(collapsed.comments[0].showReplyComposer, false);
    const expanded = threadView({
      listed, user: MEMBER, proposalId: "a", expandedIds: new Set([parent.id]),
    });
    assert.equal(expanded.comments[0].toggleLabel, "Hide replies");
    assert.equal(expanded.comments[0].visibleReplies.length, 1);
    assert.equal(expanded.comments[0].visibleReplies[0].body, "Agree on the benchmark.");
    assert.equal(expanded.comments[0].nestedCanReply, false);
    assert.equal(expanded.comments[0].showReplyComposer, true);
    assert.deepEqual(expanded.comments[0].replyPayload, { proposalId: "a", parentId: parent.id });
  });

  it("[FIT-SCR-045] should keep opportunity-level discussion read-only with no reply action", async () => {
    const db = fixture();
    db.records.set("comments/public", {
      authorId: "alice", problemId: "problem", parentId: null, text: "A public opportunity comment", createdAt: now,
    });
    await create(db);
    const listed = await listReportableComments({ db, uid: "funder", problemId: "problem" });
    const view = threadView({ listed, user: MEMBER, proposalId: null });
    assert.equal(view.canCompose, false);
    assert.equal(view.showTopLevelRecommendation, false);
    assert.equal(view.comments.length, 1);
    assert.equal(view.comments[0].body, "A public opportunity comment");
    assert.equal(view.comments[0].showReply, false);
    assert.equal(view.comments[0].showReplyComposer, false);
  });

  it("[FIT-SCR-046] should keep a removed parent placeholder until the last reply is deleted", async () => {
    const db = fixture();
    const parent = await create(db);
    const reply = await create(db, { uid: "alice", body: "Agree on the benchmark.", parentId: parent.id });
    await deleteComment({ db, uid: "funder", commentId: parent.id, now: later(1000) });
    const listed = await listReportableComments({ db, uid: "funder", proposalId: "a" });
    const view = threadView({
      listed, user: MEMBER, proposalId: "a", expandedIds: new Set([parent.id]),
    });
    assert.equal(view.comments[0].removed, true);
    assert.equal(view.comments[0].body, "This comment was removed");
    assert.equal(view.comments[0].showEdit, false);
    assert.equal(view.comments[0].showDelete, false);
    assert.equal(view.comments[0].showReport, false);
    assert.equal(view.comments[0].showReply, true);
    assert.equal(view.comments[0].visibleReplies[0].id, reply.id);
    await deleteComment({ db, uid: "alice", commentId: reply.id, now: later(2000) });
    const empty = await listReportableComments({ db, uid: "funder", proposalId: "a" });
    assert.equal(threadView({ listed: empty, user: MEMBER, proposalId: "a" }).comments.length, 0);
  });
});
