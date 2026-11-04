import test from "node:test";
import assert from "node:assert/strict";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { adminExportSelectedProposals } from "../index.js";
import { memoryDb } from "./memoryDb.mjs";

const ADMIN = `0x${"ad".repeat(20)}`;
const OTHER = `0x${"be".repeat(20)}`;
const request = (uid, data, authTime = 100) => ({
  auth: uid ? { uid, token: { auth_time: authTime } } : null, data,
});

test("export continuations recheck administrator authority and both session cutoffs", async (t) => {
  const records = {
    [`users/${ADMIN}`]: { role: 1, fullName: "Export administrator" },
    [`users/${OTHER}`]: { role: 1, fullName: "Other administrator" },
    "problems/parent": { ownerId: ADMIN, title: "Parent", status: "submitted" },
    "proposals/child": { problemId: "parent", title: "Child", summary: "Summary", status: "submitted",
      researcherId: OTHER, createdAt: Timestamp.fromMillis(1_700_000_000_000) },
  };
  for (let index = 0; index < 51; index++) records[`comments/c${String(index).padStart(3, "0")}`] = {
    proposalId: "child", authorId: OTHER, body: `Comment ${index}`,
  };
  const db = memoryDb(records);
  t.mock.method(getFirestore(), "collection", db.collection.bind(db));
  t.mock.method(getFirestore(), "runTransaction", db.runTransaction.bind(db));
  const first = await adminExportSelectedProposals.run(request(ADMIN, {
    protocolVersion: 1, requestId: "callable-auth-regression", proposalId: "child", acceptance: "all", actorUid: OTHER,
  }));
  assert.equal(first.done, false);
  const path = `proposalExportSessions/${first.exportId}`;
  assert.equal(db.records.get(path).actorUid, ADMIN, "request data cannot impersonate the session actor");
  const before = JSON.stringify(db.records.get(path));
  const auditCount = () => [...db.records.keys()].filter((key) => key.startsWith("audits/")).length;
  const denied = async (uid, code, authTime = 100) => {
    await assert.rejects(adminExportSelectedProposals.run(request(uid, first.nextCursor, authTime)), { code });
    assert.equal(JSON.stringify(db.records.get(path)), before);
    assert.equal(auditCount(), 0);
  };
  await denied(null, "unauthenticated");
  await denied(OTHER, "permission-denied");
  db.records.set(`users/${ADMIN}`, { role: 0 });
  await denied(ADMIN, "permission-denied");
  db.records.set(`users/${ADMIN}`, { role: 1, suspended: true });
  await denied(ADMIN, "permission-denied");
  db.records.set(`users/${ADMIN}`, { role: 1, sessionsValidAfterEpoch: 100 });
  await denied(ADMIN, "unauthenticated");
  db.records.set(`users/${ADMIN}`, { role: 1 });
  db.records.set(`sessionRevocations/${ADMIN}`, { sessionsValidAfterEpoch: 100 });
  await denied(ADMIN, "unauthenticated");
  const final = await adminExportSelectedProposals.run(request(ADMIN, first.nextCursor, 101));
  assert.equal(final.done, true);
  assert.equal(final.totals.commentCount, 51);
  assert.equal(auditCount(), 1);
  assert.equal(db.records.get(`audits/${final.auditId}`).actor, ADMIN);
});
