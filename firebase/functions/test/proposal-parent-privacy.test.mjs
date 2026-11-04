import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { listActionItems, listMyProposals } from "../proposalQueues.js";
import { WORKFLOW_STATUS } from "../workflowStatus.js";
import { memoryDb } from "./memoryDb.mjs";

const now = Timestamp.fromMillis(1_800_000_000_000);
function fixture(parent, proposal = {}, role = 0) {
  return memoryDb({
    "users/alice": { role },
    "proposals/mine": { researcherId: "alice", problemId: "private", status: "draft", ...proposal },
    ...(parent ? { "problems/private": { ownerId: "other", title: "Private title", expiresAt: now,
      matching: { status: "invalidated", deadlineAt: now, confirmedAt: now }, ...parent } } : {}),
  });
}
const unavailable = { id: "private", title: "", status: "", expiresAt: null, matching: null };

test("legacy owned drafts cannot disclose private or moderated parent metadata", async () => {
  for (const parent of [null, { status: "draft" }, { status: "moderated_removed" },
    { status: "submitted", moderationStatus: "hidden" }, { status: "open", moderationStatus: "removed" }]) {
    const db = fixture(parent);
    const { items } = await listMyProposals({ db, uid: "alice" });
    assert.equal(items.length, 1, "the member keeps access to their own draft");
    assert.deepEqual(items[0].posting, unavailable);
    assert.equal(items[0].workflowStatus, WORKFLOW_STATUS.DRAFT);
    const actions = await listActionItems({ db, uid: "alice", now });
    assert.equal(actions.total, 0);
    assert.deepEqual(actions.researcher, { selectionToAccept: [], grantSelectionsToAccept: [] });
  }
});

test("parent filtering also excludes private matching state from workflow and selection projections", async () => {
  const db = fixture({ status: "draft" }, { status: "submitted" });
  const { items } = await listMyProposals({ db, uid: "alice" });
  assert.deepEqual(items[0].posting, unavailable);
  assert.equal(items[0].workflowStatus, WORKFLOW_STATUS.SUBMITTED);

  const selected = fixture({ status: "draft", matching: { status: "awaiting_confirmation", proposalId: "mine" } },
    { status: "submitted", matching: { status: "awaiting_confirmation", deadlineAt: Timestamp.fromMillis(now.toMillis() + 60_000) } });
  assert.deepEqual((await listActionItems({ db: selected, uid: "alice", now })).researcher.selectionToAccept, []);
});

test("own private parents, administrators, and every member-readable posting status retain queue metadata", async () => {
  const cases = [
    [{ status: "draft", ownerId: "alice" }, 0],
    [{ status: "draft" }, 1],
    ...["submitted", "open", "cancelled", "expired"].map(status => [{ status }, 0]),
  ];
  for (const [parent, role] of cases) {
    const { items } = await listMyProposals({ db: fixture(parent, {}, role), uid: "alice" });
    assert.equal(items[0].posting.title, "Private title");
    assert.equal(items[0].posting.status, parent.status);
    assert.equal(items[0].posting.expiresAt, now.toDate().toISOString());
    assert.equal(items[0].posting.matching.status, "invalidated");
  }
});
