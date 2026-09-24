import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { memoryDb } from "./memoryDb.mjs";
import { createComment } from "../comments.js";
import { fundMockProposal, selectMockProposal } from "../matching.js";
import { listMyProposals } from "../proposalQueues.js";
import { listOwnerReviews, recordOwnerReview } from "../ownerReviews.js";

const now = Timestamp.fromMillis(1_800_000_000_000);
const rationale = "Please tighten the benchmark section before this proceeds.";

function fixture(patch = {}) {
  return memoryDb({
    "users/owner": { role: 0, fullName: "Problem owner" },
    "users/alice": { role: 0, fullName: "Alice" },
    "users/funder": { role: 0, fullName: "Funder" },
    "users/evaluator": { role: 2, fullName: "Assigned evaluator" },
    "users/admin": { role: 1, fullName: "Moderator" },
    "problems/problem": { ownerId: "owner", title: "Routing study", status: "open", currency: "SGD", createdAt: now },
    "proposals/a": {
      researcherId: "alice", postingOwnerId: "owner", problemId: "problem", title: "Proposal A",
      status: "submitted", amount: 100, currency: "SGD", createdAt: now, ...patch,
    },
  });
}

const record = (db, patch = {}) => recordOwnerReview({
  db, uid: "owner", proposalId: "a", outcome: "feedback", rationale, requestId: "review-1", now, ...patch,
});

test("the designated owner records feedback without changing status or matching", async () => {
  const db = fixture();
  const saved = await record(db);
  assert.equal(saved.actorId, "owner");
  assert.equal(saved.actorRole, "problem_owner");
  assert.equal(saved.outcome, "feedback");
  assert.equal(saved.rationale, rationale);
  assert.equal(saved.correctionPathOpen, true);
  const proposal = db.records.get("proposals/a");
  assert.equal(proposal.status, "submitted");
  assert.equal(proposal.matching, undefined);
  assert.equal(db.records.get("problems/problem").matching, undefined);
  assert.equal([...db.records.keys()].some((path) => path.startsWith("matchingEvents/")), false);
  const notice = [...db.records.entries()].find(([path]) => path.startsWith("moderationNotifications/"));
  assert.equal(notice[1].recipientId, "alice");
  assert.equal(notice[1].kind, "owner_review");
  assert.equal(notice[1].navigationTarget, "proposal/a");
  const again = await record(db);
  assert.equal(again.id, saved.id);
  assert.equal([...db.records.keys()].filter((path) => path.includes("/ownerReviews/")).length, 1);
});

test("a revision request leaves the proposal submitted for the existing edit path", async () => {
  const db = fixture();
  const saved = await record(db, { outcome: "revision_requested", requestId: "revise-1" });
  assert.equal(saved.outcome, "revision_requested");
  assert.equal(saved.correctionPathOpen, true);
  assert.equal(db.records.get("proposals/a").status, "submitted");
  const queue = await listMyProposals({ db, uid: "alice" });
  assert.equal(queue.items[0].ownerReview.outcome, "revision_requested");
  assert.equal(queue.items[0].ownerReview.correctionPathOpen, true);
});

test("revision requests are refused once editing is closed", async () => {
  const locked = [
    { status: "under_review" },
    { matching: { evaluationComplete: true } },
    { matching: { fundedMinor: 100, fundedAmount: 1, status: "funding" } },
    { matching: { status: "awaiting_confirmation" } },
  ];
  for (const patch of locked) {
    const db = fixture(patch);
    await assert.rejects(() => record(db, { outcome: "revision_requested", requestId: "revise-locked" }), { code: "failed-precondition" });
    assert.equal([...db.records.keys()].some((path) => path.includes("/ownerReviews/")), false);
  }
});

test("not progressing stays a record and the proposal can still be selected later", async () => {
  const db = fixture({ matching: { evaluationComplete: true } });
  await fundMockProposal({ db, uid: "funder", problemId: "problem", proposalId: "a", amount: 100, requestId: "fund-a-request-01", now });
  const saved = await record(db, { outcome: "not_progressing", requestId: "stop-1", rationale: "This approach is not progressing for this round." });
  assert.equal(saved.outcome, "not_progressing");
  assert.equal(db.records.get("proposals/a").status, "submitted");
  assert.equal(db.records.get("proposals/a").matching.status, "funding");
  assert.equal(db.records.get("problems/problem").matching.status, "open");
  await selectMockProposal({
    db, uid: "owner", problemId: "problem", proposalId: "a",
    rationale: "Selecting this proposal after the interim note.", now,
  });
  assert.equal(db.records.get("proposals/a").matching.status, "awaiting_confirmation");
});

test("only the designated problem owner can record a review", async () => {
  const db = fixture();
  await assert.rejects(() => record(db, { uid: "alice", requestId: "author" }), { code: "permission-denied" });
  await assert.rejects(() => record(db, { uid: "evaluator", requestId: "evaluator" }), { code: "permission-denied" });
  await assert.rejects(() => record(db, { uid: "funder", requestId: "funder" }), { code: "permission-denied" });
  await assert.rejects(() => record(db, { uid: "admin", requestId: "admin" }), { code: "permission-denied" });
  await assert.rejects(() => record(db, { rationale: "short", requestId: "short" }), { code: "invalid-argument" });
});

test("owner review closes once winner selection has started", async () => {
  const db = fixture({ matching: { status: "awaiting_confirmation", evaluationComplete: true, fundedMinor: 10000 } });
  db.records.get("problems/problem").matching = { status: "awaiting_confirmation", proposalId: "a" };
  await assert.rejects(() => record(db, { outcome: "feedback", requestId: "late" }), { code: "failed-precondition" });
});

test("the author and owner can read the trail; an evaluator cannot", async () => {
  const db = fixture();
  await record(db);
  const author = await listOwnerReviews({ db, uid: "alice", proposalId: "a" });
  assert.equal(author.items[0].rationale, rationale);
  const owner = await listOwnerReviews({ db, uid: "owner", proposalId: "a" });
  assert.equal(owner.items.length, 1);
  await assert.rejects(() => listOwnerReviews({ db, uid: "evaluator", proposalId: "a" }), { code: "permission-denied" });
});

test("an evaluator recommendation does not create an owner review", async () => {
  const db = fixture();
  await createComment({ db, uid: "evaluator", proposalId: "a", body: "Recommend this approach.", recommendation: "recommend", now });
  assert.equal([...db.records.keys()].some((path) => path.includes("/ownerReviews/")), false);
  const queue = await listMyProposals({ db, uid: "alice" });
  assert.equal(queue.items[0].ownerReview, null);
  assert.equal(queue.items[0].qualifying, 1);
});
