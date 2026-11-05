import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { memoryDb } from "./memoryDb.mjs";
import { moderateContent } from "../moderation.js";
import { enqueueModerationVoidJobs, reconcileModerationVoidEnumerations, VOID_ENUMERATIONS,
  VOID_ENUMERATION_PAGE, VOID_JOBS, moderationVoidReasonHash } from "../escrowModerationVoid.js";
import { feedbackByProposal, listMyProposals, listEvaluatorQueue, DASHBOARD_COMMENT_CAP } from "../proposalQueues.js";
import { collectOwnerDashboard } from "../ownerDashboard.js";
import { createComment } from "../comments.js";
import { enqueueIndependentFundingCancellation, INDEPENDENT_FUNDING_CANCELLATIONS } from "../independentFundingModeration.js";

const now = Timestamp.fromMillis(1_800_000_000_000);
const future = Timestamp.fromMillis(now.toMillis() + 86_400_000);
const id = (prefix, index) => `${prefix}${String(index).padStart(4, "0")}`;
const proposal = (extra = {}) => ({ problemId: "p", researcherId: "alice", postingOwnerId: "owner",
  status: "submitted", title: "Solution", createdAt: now, ...extra });
const base = () => ({
  "users/admin": { role: 1 }, "users/owner": { role: 0 }, "users/alice": { role: 0 },
  "users/attacker": { role: 0 }, "users/evaluator": { role: 2 },
  "problems/p": { ownerId: "owner", status: "open", title: "Posting", createdAt: now, expiresAt: future },
  "moderationQueue/problem_p": { contentType: "problem", contentId: "p", status: "pending" },
});
const voids = (db) => [...db.records.entries()].filter(([path]) => path.startsWith(`${VOID_JOBS}/`));

test("independent removal atomically preserves cancellation after a callable crash and later retries never reset it", async () => {
  const db = memoryDb({ ...base(),
    "proposals/indie": { researcherId: "alice", proposalKind: "independent", status: "submitted", title: "Independent",
      fundingTerms: { target: "1" }, createdAt: now },
    "moderationQueue/proposal_indie": { contentType: "proposal", contentId: "indie", status: "pending" },
  });
  const args = { db, uid: "admin", queueId: "proposal_indie", action: "remove", reason: "spam", now };
  const removed = await moderateContent(args);
  // Stop immediately after the moderation transaction: no postcommit enqueue is called.
  const path = `${INDEPENDENT_FUNDING_CANCELLATIONS}/${removed.eventId}_indie`;
  const pending = db.records.get(path);
  assert.equal(db.records.get("proposals/indie").moderationStatus, "removed");
  assert.equal(pending.status, "pending");
  assert.equal(pending.nextAttemptAt, now);
  assert.equal(pending.reasonHash, moderationVoidReasonHash(removed.eventId, "spam"));
  assert.deepEqual(db.records.get(`moderationEvents/${removed.eventId}`).independentFundingCancellation, { status: "queued" });
  assert.equal((await moderateContent(args)).unchanged, true);
  assert.deepEqual(db.records.get(path), pending);
  const completed = { ...pending, status: "complete", transactionHash: "confirmed-hash" };
  db.records.set(path, completed);
  assert.equal((await enqueueIndependentFundingCancellation({ db, contentType: "proposal", contentId: "indie",
    eventId: removed.eventId, reason: "different retry reason", now: future })).enqueued, 0);
  assert.deepEqual(db.records.get(path), completed, "postcommit retry retains completion and the original reason/timestamps");
  assert.equal([...db.records.keys()].filter((key) => key.startsWith(`${INDEPENDENT_FUNDING_CANCELLATIONS}/`)).length, 1);
});

test("independent removal rolls back if its durable cancellation checkpoint cannot be written", async () => {
  const db = memoryDb({ ...base(),
    "proposals/indie": { researcherId: "alice", proposalKind: "independent", status: "submitted", title: "Independent", createdAt: now },
    "moderationQueue/proposal_indie": { contentType: "proposal", contentId: "indie", status: "pending" },
  });
  const run = db.runTransaction.bind(db);
  db.runTransaction = (body) => run((tx) => body({ ...tx, set: (ref, ...args) => {
    if (ref.path.startsWith(`${INDEPENDENT_FUNDING_CANCELLATIONS}/`)) throw new Error("checkpoint write failed");
    return tx.set(ref, ...args);
  } }));
  await assert.rejects(() => moderateContent({ db, uid: "admin", queueId: "proposal_indie", action: "remove", reason: "spam", now }), /checkpoint write failed/);
  assert.equal(db.records.get("proposals/indie").status, "submitted");
  assert.equal(db.records.get("moderationQueue/proposal_indie").status, "pending");
  assert.equal([...db.records.keys()].some((key) => key.startsWith("moderationEvents/")), false);
});

test("draft flooding cannot starve removal jobs; legitimate escrows continue across bounded durable pages", async () => {
  const initial = base(), queries = [];
  for (let i = 0; i < 250; i++) initial[`proposals/${id("a-draft", i)}`] = proposal({ status: "draft" });
  for (let i = 0; i < 225; i++) initial[`proposals/${id("z-funded", i)}`] = proposal({ fundingTerms: { target: "1" } });
  initial["proposals/independent"] = proposal({ proposalKind: "independent", fundingTerms: { target: "1" } });
  initial["proposals/legacy"] = proposal();
  const db = memoryDb(initial, { onQuery: (query) => queries.push(query) });
  const removed = await moderateContent({ db, uid: "admin", queueId: "problem_p", action: "remove", reason: "spam", now });
  const checkpoint = `${VOID_ENUMERATIONS}/${removed.eventId}`;
  assert.equal(db.records.get(checkpoint).status, "pending", "work commits with removal before the callable enqueue runs");
  // Simulate a crashed callable: the scheduled worker must find all work unaided.
  for (let pass = 0; pass < 4; pass++) await reconcileModerationVoidEnumerations({ db, now });
  assert.equal(voids(db).length, 225);
  assert.equal(db.records.get(checkpoint).status, "complete");
  assert.equal(db.records.get(checkpoint).enqueued, 225);
  const event = db.records.get(`moderationEvents/${removed.eventId}`);
  assert.deepEqual(event.escrowVoid, { status: "queued", enumerationComplete: true, enqueuedCount: 225 });
  assert.equal(JSON.stringify(event.escrowVoid).length < 150, true, "event metadata never grows with child ids");
  assert.equal(queries.filter((query) => query.name === "proposals").every((query) => query.cap === VOID_ENUMERATION_PAGE + 1), true);
  assert.equal(queries.filter((query) => query.name === "proposals").every((query) => query.returned <= VOID_ENUMERATION_PAGE + 1), true);
  await reconcileModerationVoidEnumerations({ db, now });
  assert.equal(voids(db).length, 225, "completed enumeration is idempotent");
});

test("a failed enumeration page retains its cursor and resumes without losing or duplicating jobs", async () => {
  const initial = base();
  for (let i = 0; i < 205; i++) initial[`proposals/${id("funded", i)}`] = proposal({ fundingTerms: { target: "1" } });
  const db = memoryDb(initial);
  const removed = await moderateContent({ db, uid: "admin", queueId: "problem_p", action: "remove", reason: "spam", now });
  const args = { db, contentType: "problem", contentId: "p", eventId: removed.eventId, reason: "forged reason", now };
  await enqueueModerationVoidJobs(args);
  const checkpoint = `${VOID_ENUMERATIONS}/${removed.eventId}`;
  const prior = { ...db.records.get(checkpoint) };
  const run = db.runTransaction.bind(db);
  let failed = false;
  db.runTransaction = (body) => run((tx) => body({ ...tx, get: (ref) => {
    if (!failed && ref.path?.startsWith(`${VOID_JOBS}/`)) { failed = true; throw new Error("interrupted page"); }
    return tx.get(ref);
  } }));
  await assert.rejects(() => enqueueModerationVoidJobs(args), /interrupted page/);
  assert.deepEqual(db.records.get(checkpoint), prior);
  assert.equal(voids(db).length, 100);
  await Promise.all([enqueueModerationVoidJobs(args), enqueueModerationVoidJobs(args)]);
  assert.equal(voids(db).length, 205);
  assert.equal(db.records.get(checkpoint).status, "complete");
  assert.equal(voids(db).every(([, job]) => job.reasonHash === moderationVoidReasonHash(removed.eventId, "spam")), true);
  assert.equal((await enqueueModerationVoidJobs(args)).enqueued, 0);
});

const comment = (extra = {}) => ({ proposalId: "a", authorId: "attacker", parentId: null, body: "Discussion",
  moderationStatus: "visible", qualifying: false, recommendation: null, createdAt: now, ...extra });

test("dashboard reads stay bounded per proposal and preserve feedback on unflooded proposals", async () => {
  const initial = { ...base(), "proposals/a": proposal(), "proposals/b": proposal() }, queries = [];
  for (let i = 0; i < 350; i++) initial[`comments/${id("flood", i)}`] = comment();
  initial["comments/a-recommendation"] = comment({ authorId: "evaluator", qualifying: true, recommendation: "recommend", badge: "evaluator" });
  initial["comments/b-recommendation"] = comment({ proposalId: "b", authorId: "evaluator", qualifying: true, recommendation: "do_not_recommend", badge: "evaluator" });
  const db = memoryDb(initial, { onQuery: (query) => queries.push(query) });
  // The flood is achievable through the normal authenticated top-level comment path.
  await createComment({ db, uid: "attacker", proposalId: "a", body: "One more top-level comment", now });
  queries.length = 0;
  const feedback = await feedbackByProposal(db, ["a", "b"]);
  assert.equal(feedback.get("a").feedbackTruncated, true);
  assert.equal(feedback.get("a").qualifying, 1, "discussion spam cannot hide qualifying feedback");
  assert.equal(feedback.get("b").feedbackTruncated, false);
  assert.equal(feedback.get("b").comments, 1);
  assert.deepEqual(feedback.get("b").recommendations, ["do_not_recommend"]);
  assert.equal(queries.length, 4);
  assert.equal(queries.every((query) => query.cap === DASHBOARD_COMMENT_CAP + 1), true);
  assert.equal(queries.reduce((sum, query) => sum + query.returned, 0) <= 4 * (DASHBOARD_COMMENT_CAP + 1), true);
  const mine = await listMyProposals({ db, uid: "alice" });
  assert.equal(mine.feedbackTruncated, true);
  const owner = await collectOwnerDashboard({ db, uid: "owner", readFeedback: feedbackByProposal, now: now.toMillis() });
  assert.equal(owner.truncated.feedback, true);
  assert.equal(owner.postings[0].feedbackTruncated, true);
});

test("evaluator history limits ignore reply floods and preserve a qualifying filing after many removed filings", async () => {
  const initial = { ...base(), "proposals/a": proposal({ matching: { recommendations: {
    evaluator: { commentId: "z-current", recommendation: "recommend", at: now },
  } } }) }, queries = [];
  for (let i = 0; i < 150; i++) {
    initial[`comments/${id("reply", i)}`] = comment({ authorId: "evaluator", parentId: "parent" });
    initial[`comments/${id("removed", i)}`] = comment({ authorId: "evaluator", recommendation: "do_not_recommend", moderationStatus: "removed" });
  }
  initial["comments/z-current"] = comment({ authorId: "evaluator", qualifying: true, recommendation: "recommend" });
  const db = memoryDb(initial, { onQuery: (query) => queries.push(query) });
  const queue = await listEvaluatorQueue({ db, uid: "evaluator", filter: "submitted" });
  assert.equal(queue.items[0].myCommentId, "z-current");
  assert.equal(queue.items[0].needsAttention, false);
  assert.equal(queue.items[0].recommendationHistoryTruncated, true);
  assert.equal(queue.recommendationHistoryTruncated, true);
  const commentReads = queries.filter((query) => query.name === "comments");
  assert.equal(commentReads.length, 2);
  assert.equal(commentReads.every((query) => Number.isFinite(query.cap) && query.cap <= DASHBOARD_COMMENT_CAP + 1), true);
  assert.equal(commentReads.reduce((sum, query) => sum + query.returned, 0), DASHBOARD_COMMENT_CAP + 2);
});
