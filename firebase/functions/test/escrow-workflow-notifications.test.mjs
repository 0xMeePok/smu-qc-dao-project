import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { escrowWorkflowNotices, notifyEscrowWorkflowEvent } from "../escrowWorkflowNotifications.js";
import { memoryDb } from "./memoryDb.mjs";

const owner = `0x${"1".repeat(40)}`, researcher = `0x${"2".repeat(40)}`, funder = `0x${"3".repeat(40)}`;
const now = Timestamp.fromMillis(1_900_000_000_000);
const fixture = () => memoryDb({
  "problems/posting-1": { ownerId: owner, title: "Routing" },
  "proposals/p1": { researcherId: researcher, postingOwnerId: owner, problemId: "posting-1", title: "Quantum routing" },
});
const event = (eventType, extra = {}) => ({ eventType, proposalId: "p1", problemId: "posting-1", verified: true,
  timestamp: 1_899_000_000, transactionHash: `0x${"a".repeat(64)}`, ...extra });
const notices = (db) => [...db.records.entries()].filter(([path]) => path.startsWith("moderationNotifications/"))
  .map(([path, row]) => ({ path, ...row }));

test("[QCDAO-68] the researcher is told when the owner selects their escrow proposal", async () => {
  const db = fixture();
  const result = await notifyEscrowWorkflowEvent({ db, eventId: "e1", now,
    event: event("SelectionLocked", { actor: owner, deadlineAt: "1899604800" }) });
  assert.equal(result.delivered, 1);
  const [notice] = notices(db);
  assert.equal(notice.recipientId, researcher);
  assert.equal(notice.kind, "escrow");
  assert.equal(notice.workflowStatus, "selected");
  assert.equal(notice.navigationTarget, "proposal/p1");
  assert.match(notice.message, /selected your proposal “Quantum routing”/);
  assert.match(notice.message, /by 2030-03-13 04:00:00 UTC/);
  assert.equal(notice.readAt, null);
});

test("[QCDAO-68] both parties hear a rejected selection; retries keep one notice each", async () => {
  const db = fixture();
  const rejected = event("SelectionInvalidated", { actor: researcher, refundReason: "selection_declined" });
  await notifyEscrowWorkflowEvent({ db, eventId: "e2", now, event: rejected });
  // The researcher rejected, so only the owner is told; the researcher still
  // gets the escrow cancellation that follows.
  assert.deepEqual(notices(db).map((row) => row.recipientId), [owner]);
  assert.match(notices(db)[0].message, /The selection was rejected/);
  const cancelled = event("Cancelled", { actor: owner, refundReason: "cancelled" });
  await notifyEscrowWorkflowEvent({ db, eventId: "e3", now, event: cancelled });
  await notifyEscrowWorkflowEvent({ db, eventId: "e3", now, event: cancelled });
  const forResearcher = notices(db).filter((row) => row.recipientId === researcher);
  assert.equal(forResearcher.length, 1);
  assert.match(forResearcher[0].message, /contributors can claim refunds/);
});

test("unverified, admin-cancelled and funder events add no researcher notices", async () => {
  const db = fixture();
  assert.equal((await notifyEscrowWorkflowEvent({ db, eventId: "u", now, event: event("SelectionLocked", { verified: false }) })).delivered, 0);
  assert.equal((await notifyEscrowWorkflowEvent({ db, eventId: "v", now, event: event("Voided", { refundReason: "admin_cancelled" }) })).delivered, 0);
  assert.equal((await notifyEscrowWorkflowEvent({ db, eventId: "d", now, event: event("Deposit", { actor: funder }) })).delivered, 0);
  assert.equal((await notifyEscrowWorkflowEvent({ db, eventId: "t", now, event: event("TrancheReleased") })).delivered, 0);
  assert.equal(notices(db).length, 0);
});

test("delivery evidence notifies only the owner, and approvals notify the other party", () => {
  const parties = { researcherId: researcher, ownerId: owner, title: "T" };
  assert.deepEqual(escrowWorkflowNotices(event("MilestoneSubmitted", { actor: researcher }), parties).map((row) => row.recipientId), [owner]);
  assert.deepEqual(escrowWorkflowNotices(event("Approval", { actor: owner }), parties).map((row) => row.recipientId), [researcher]);
  assert.deepEqual(escrowWorkflowNotices(event("Approval", { actor: researcher }), parties).map((row) => row.recipientId), [owner]);
});
