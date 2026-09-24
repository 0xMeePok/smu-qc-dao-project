import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

const create = (db, patch = {}) =>
  createComment({
    db,
    uid: "funder",
    proposalId: "a",
    body: "The claimed latency needs a cited benchmark.",
    now,
    ...patch,
  });

function source(relativeFromTest) {
  return readFileSync(new URL(relativeFromTest, import.meta.url), "utf8");
}

describe("[QCDAO-70] reply to comments in a threaded discussion", () => {
  it("[FUT-SCR-141] accepts a single-level reply, increments replyCount, and rejects a nested or forged parent", async () => {
    const db = fixture();
    const parent = await create(db);
    const reply = await create(db, { uid: "alice", body: "Agree on the benchmark.", parentId: parent.id });
    assert.equal(reply.parentId, parent.id);
    assert.equal(db.records.get(`comments/${parent.id}`).replyCount, 1);
    await assert.rejects(() => create(db, { parentId: reply.id, body: "Nested reply." }), {
      code: "failed-precondition",
    });
    await assert.rejects(() => create(db, { parentId: "forged" }), { code: "not-found" });
    assert.equal(db.records.get(`comments/${parent.id}`).replyCount, 1);
  });

  it("[FUT-SCR-142] lets an evaluator reply without a recommendation and never treats a reply as qualifying", async () => {
    const db = fixture();
    const parent = await create(db);
    const reply = await create(db, {
      uid: "evaluator",
      body: "Need the cited figure as well.",
      parentId: parent.id,
    });
    assert.equal(reply.parentId, parent.id);
    assert.equal(reply.recommendation, null);
    assert.equal(reply.qualifying, false);
    assert.equal(db.records.get("proposals/a").matching?.evaluationComplete === true, false);
    await assert.rejects(
      () => create(db, {
        uid: "evaluator",
        parentId: parent.id,
        recommendation: "recommend",
        body: "Spoof.",
      }),
      { code: "invalid-argument" },
    );
  });

  it("[FUT-SCR-143] lists parents only and nests replies under the parent, including newest-first parent sort", async () => {
    const db = fixture();
    const parent = await create(db);
    const sibling = await create(db, {
      uid: "evaluator",
      recommendation: "recommend",
      body: "Evaluator view.",
      now: later(1000),
    });
    const reply = await create(db, {
      uid: "alice",
      body: "Need the cited figure.",
      parentId: parent.id,
      now: later(2000),
    });
    const oldest = await listReportableComments({ db, uid: "funder", proposalId: "a" });
    assert.equal(oldest.items.length, 2);
    assert.equal(oldest.items[0].id, parent.id);
    assert.equal(oldest.items[0].parentId, null);
    assert.equal(oldest.items[0].replyCount, 1);
    assert.equal(oldest.items[0].replies.length, 1);
    assert.equal(oldest.items[0].replies[0].id, reply.id);
    assert.equal(oldest.items[0].replies[0].parentId, parent.id);
    assert.equal(oldest.items.some((item) => item.id === reply.id), false);
    const newest = await listReportableComments({ db, uid: "funder", proposalId: "a", sort: "newest" });
    assert.equal(newest.items.map((item) => item.id).join(","), `${sibling.id},${parent.id}`);
    assert.equal(newest.items.find((item) => item.id === parent.id).replies[0].id, reply.id);
  });

  it("[FUT-SCR-144] replies from the parent only, collapsed by default, without a recommendation picker", () => {
    const ui = source("../../src/components/ReportableComments.jsx");
    assert.match(ui, /parent && canReply && <button type="button" className="text-button" onClick=\{onReply\}>Reply<\/button>/);
    assert.match(ui, /nested editing=\{editingId === reply\.id\}/);
    assert.match(ui, /Hide replies/);
    assert.match(ui, /Show \$\{count\} replies/);
    assert.match(ui, /const recommend = evaluator && !reply;/);
    assert.match(ui, /createComment\(\{ proposalId, \.\.\.payload, \.\.\.\(parentId \? \{ parentId \} : \{\}\) \}\)/);
    assert.match(ui, /Write a reply/);
    assert.match(ui, /Post reply/);
    const posting = source("../../src/pages/PostingDetailPage.jsx");
    assert.match(posting, /<ReportableComments problemId=\{posting\.id\} \/>/);
    assert.doesNotMatch(posting, /proposalId=\{/);
  });

  it("[FUT-SCR-146] pages a long thread instead of loading every reply in one response", () => {
    const ui = source("../../src/components/ReportableComments.jsx");
    assert.match(ui, /Load more replies/);
    assert.match(ui, /onLoadReplies\(item\.id, replyCursor\)/);
    assert.match(ui, /threadId/);
    const server = source("../../../firebase/functions/moderation.js");
    assert.match(server, /const REPLY_PREVIEW = \d+;/);
    assert.match(server, /const THREAD_REPLY_PAGE = \d+;/);
    assert.match(server, /const AUTHOR_LOOKUP_CAP = \d+;/);
    // A reply query must be bounded per parent, never "every reply under these ids".
    assert.doesNotMatch(server, /where\("parentId", "in"/);
    const comments = source("../../../firebase/functions/comments.js");
    assert.match(comments, /REPLIES_PER_THREAD/);
    assert.match(comments, /REPLIES_PER_MEMBER_PER_THREAD/);
  });

  it("[FUT-SCR-145] keeps a removed parent placeholder while replies remain, then drops the thread", async () => {
    const db = fixture();
    const parent = await create(db);
    const reply = await create(db, { uid: "alice", body: "Agree on the benchmark.", parentId: parent.id });
    await deleteComment({ db, uid: "funder", commentId: parent.id, now: later(1000) });
    const listed = await listReportableComments({ db, uid: "funder", proposalId: "a" });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].deleted, true);
    assert.equal(listed.items[0].body, "");
    assert.equal(listed.items[0].replies[0].id, reply.id);
    const ui = source("../../src/components/ReportableComments.jsx");
    assert.match(ui, /This comment was removed/);
    assert.match(ui, /removed \? "This comment was removed"/);
    await deleteComment({ db, uid: "alice", commentId: reply.id, now: later(2000) });
    assert.equal(db.records.get(`comments/${parent.id}`).replyCount, 0);
    assert.equal((await listReportableComments({ db, uid: "funder", proposalId: "a" })).items.length, 0);
  });
});
