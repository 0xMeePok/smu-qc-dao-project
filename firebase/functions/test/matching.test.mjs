import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { memoryDb } from "./memoryDb.mjs";
import {
  completeMockEvaluation,
  confirmMockProposal,
  declineMockProposal,
  forceExpireMockMatch,
  fundMockProposal,
  getMockMatching,
  selectMockProposal,
} from "../matching.js";

const now = Timestamp.fromMillis(1_800_000_000_000);
const later = (ms) => Timestamp.fromMillis(now.toMillis() + ms);

function fixture() {
  return memoryDb({
    "users/admin": { role: 1 },
    "users/owner": {},
    "users/alice": {},
    "users/funder": {},
    "problems/problem": { ownerId: "owner", currency: "SGD", status: "open", expiresAt: later(30 * 86400000) },
    "proposals/a": {
      researcherId: "alice", problemId: "problem", title: "A", amount: 100, currency: "SGD", status: "submitted",
      matching: { evaluationComplete: true },
    },
    "proposals/b": {
      researcherId: "bob", problemId: "problem", title: "B", amount: 100, currency: "SGD", status: "submitted",
      matching: { evaluationComplete: true },
    },
  });
}

const fund = (db, proposalId = "a", amount = 100, requestId = "request_1234567890", uid = "funder") =>
  fundMockProposal({ db, problemId: "problem", proposalId, amount, requestId, uid, now });
const select = (db, proposalId = "a", uid = "owner") =>
  selectMockProposal({ db, rationale: "This approach meets our requirements.", problemId: "problem", proposalId, uid, now });

test("escrow-linked proposals reject every mock mutation before expiry or idempotent replay can write", async () => {
  const actions = [
    (db) => fund(db),
    (db) => select(db),
    (db) => confirmMockProposal({ db, problemId: "problem", proposalId: "a", uid: "alice", now }),
    (db) => declineMockProposal({ db, uid: "alice", problemId: "problem", proposalId: "a", reason: "No longer able to proceed.", now }),
    (db) => completeMockEvaluation({ db, uid: "admin", problemId: "problem", proposalId: "a", now }),
    (db) => forceExpireMockMatch({ db, uid: "admin", problemId: "problem", now }),
  ];
  for (const action of actions) {
    const db = fixture();
    await fund(db);
    await select(db);
    db.records.get("proposals/a").fundingTerms = { trancheBps: [5000, 5000] };
    db.records.get("problems/problem").matching.deadlineAt = later(-1);
    const before = JSON.stringify([...db.records]);
    await assert.rejects(() => action(db), { code: "failed-precondition", message: /uses wallet escrow/ });
    assert.equal(JSON.stringify([...db.records]), before);
  }
});

test("escrow records expose their routing marker without mock funding capabilities or balances", async () => {
  const db = fixture();
  await fund(db);
  await select(db);
  const terms = { trancheBps: [5000, 5000] };
  db.records.get("proposals/a").fundingTerms = terms;
  for (const uid of ["owner", "alice", "funder", "admin"]) {
    const result = await getMockMatching({ db, uid, problemId: "problem", now });
    const item = result.proposals.find((proposal) => proposal.id === "a");
    assert.deepEqual(item.fundingTerms, terms);
    assert.equal(item.fundedAmount, 0);
    assert.equal(item.matching.status, "escrow");
    for (const key of ["canFund", "canSelect", "canApproveOwner", "canConfirm", "canDecline", "canCompleteEvaluation"]) {
      assert.equal(item[key], false, key);
    }
    assert.equal(result.canForceExpire, false);
  }
});

test("legacy mock settlement cannot rewrite escrow sibling lifecycle state", async () => {
  const db = fixture();
  await fund(db);
  await fund(db, "b", 50, "request_second_1234");
  db.records.get("proposals/b").fundingTerms = { trancheBps: [5000, 5000] };
  const before = JSON.stringify(db.records.get("proposals/b"));
  await select(db);
  await confirmMockProposal({ db, problemId: "problem", proposalId: "a", uid: "alice", now });
  assert.equal(JSON.stringify(db.records.get("proposals/b")), before);
});
