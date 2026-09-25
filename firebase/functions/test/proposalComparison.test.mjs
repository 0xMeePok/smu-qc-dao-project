import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { memoryDb } from "./memoryDb.mjs";
import { createComment, deleteComment } from "../comments.js";
import { fundMockProposal } from "../matching.js";
import { getProposalComparison } from "../proposalComparison.js";

const now = Timestamp.fromMillis(1_800_000_000_000);
const later = (ms) => Timestamp.fromMillis(now.toMillis() + ms);
const keysOf = (value, found = []) => {
  if (!value || typeof value !== "object") return found;
  for (const [key, item] of Object.entries(value)) {
    found.push(key);
    keysOf(item, found);
  }
  return found;
};

function fixture() {
  return memoryDb({
    "users/owner": { role: 0, fullName: "Owner" },
    "users/funder": { role: 0, fullName: "Funder" },
    "users/evaluator": { role: 2, fullName: "Evaluator" },
    "users/alice": { role: 0, fullName: "Alice Researcher" },
    "publicProfiles/alice": { fullName: "Alice Researcher", organisation: "SMU" },
    "publicProfiles/bob": { fullName: "Bob Developer", organisation: "Quantum Lab" },
    "problems/problem": { ownerId: "owner", currency: "SGD", status: "open", expiresAt: later(30 * 86400000) },
    "proposals/alpha": {
      researcherId: "alice", postingOwnerId: "owner", problemId: "problem", title: "Alpha annealing",
      summary: "Anneal the stops.", methodology: "Compare with a classical baseline.", category: "quantum-annealing",
      amount: 100, currency: "SGD", status: "submitted", createdAt: now,
    },
    "proposals/bravo": {
      researcherId: "bob", postingOwnerId: "owner", problemId: "problem", title: "Bravo routes",
      summary: "A second approach.", category: "hybrid", amount: 40, currency: "SGD", status: "submitted", createdAt: now,
    },
    "proposals/draft": { researcherId: "alice", problemId: "problem", title: "Draft", status: "draft", createdAt: now },
    "proposals/hidden": {
      researcherId: "alice", problemId: "problem", title: "Hidden", status: "submitted", moderationStatus: "hidden", createdAt: now,
    },
  });
}

const comment = (db, patch) => createComment({
  db, uid: "evaluator", proposalId: "alpha", body: "The benchmark needs a citation.", recommendation: "recommend", now, ...patch,
});

test("[BUT-SPE-34] comparison lists advisory recommendation counts and keeps selection behind both gates", async () => {
  const db = fixture();
  await createComment({ db, uid: "funder", proposalId: "alpha", body: "Useful context from a funder.", now });
  const endorsed = await comment(db);
  // A solution carries ONE recommendation: a competing one is refused, not counted.
  await assert.rejects(
    () => comment(db, { body: "I would not proceed.", recommendation: "do_not_recommend" }),
    { code: "failed-precondition" },
  );
  await createComment({ db, uid: "alice", proposalId: "alpha", body: "Agreed.", parentId: endorsed.id, now: later(1) });
  await comment(db, { proposalId: "bravo", body: "Revise the baseline.", recommendation: "recommend_with_revisions", now: later(2) });

  const summary = db.records.get("proposalFeedbackSummaries/alpha");
  assert.equal(summary.recommend, 1);
  assert.equal(summary.recommend_with_revisions, 0);
  assert.equal(summary.do_not_recommend, 0);
  assert.equal(summary.qualifyingCount, 1);
  assert.equal(summary.commentCount, 3);
  assert.equal(summary.qftGrade, undefined);

  const beforeFunding = await getProposalComparison({ db, uid: "owner", problemId: "problem", now });
  assert.deepEqual(beforeFunding.rows.map((row) => row.id), ["alpha", "bravo"]);
  assert.equal(beforeFunding.viewerIsOwner, true);
  assert.equal(beforeFunding.advisory, true);
  assert.equal(beforeFunding.rows[0].developerName, "Alice Researcher");
  assert.equal(beforeFunding.rows[0].organisation, "SMU");
  assert.equal(beforeFunding.rows[0].category, "quantum-annealing");
  assert.equal(beforeFunding.rows[0].canSelect, false);
  assert.match(beforeFunding.rows[0].selectionHint, /full funding/);
  const names = keysOf(beforeFunding);
  for (const key of ["score", "qftGrade", "rank", "winner", "preferred", "weightedScore"]) {
    assert.equal(names.includes(key), false, key);
  }

  await fundMockProposal({ db, uid: "funder", problemId: "problem", proposalId: "alpha", amount: 100, requestId: "request_alpha_funded", now });
  await fundMockProposal({ db, uid: "funder", problemId: "problem", proposalId: "bravo", amount: 40, requestId: "request_bravo_funded", now: later(3) });
  const owner = await getProposalComparison({ db, uid: "owner", problemId: "problem", now: later(4) });
  assert.equal(owner.rows.find((row) => row.id === "alpha").canSelect, true);
  assert.equal(owner.rows.find((row) => row.id === "bravo").canSelect, true);
  assert.equal(owner.rows.find((row) => row.id === "bravo").recommendations.recommend_with_revisions, 1);
  const funder = await getProposalComparison({ db, uid: "funder", problemId: "problem", now: later(4) });
  const evaluator = await getProposalComparison({ db, uid: "evaluator", problemId: "problem", now: later(4) });
  assert.equal(funder.viewerIsOwner, false);
  assert.ok(funder.rows.every((row) => row.canSelect === false && row.selectionHint == null));
  assert.ok(evaluator.rows.every((row) => row.canSelect === false && row.selectionHint == null));

  const qualifying = [...db.records.entries()].filter(([, value]) => value?.proposalId === "alpha" && value.qualifying);
  for (const [path] of qualifying) {
    await deleteComment({ db, uid: "evaluator", commentId: path.split("/").at(-1), now: later(5) });
  }
  assert.equal(db.records.get("proposalFeedbackSummaries/alpha").qualifyingCount, 0);
  assert.equal(db.records.get("proposals/alpha").matching.evaluationComplete, false);
  const closed = await getProposalComparison({ db, uid: "owner", problemId: "problem", now: later(6) });
  const alpha = closed.rows.find((row) => row.id === "alpha");
  assert.equal(alpha.canSelect, false);
  assert.match(alpha.selectionHint, /qualifying evaluator recommendation/);
});
