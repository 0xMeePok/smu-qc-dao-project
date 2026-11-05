import assert from "node:assert/strict";
import { it } from "node:test";
import { evaluationExpiryAccepted, evaluationSlotId } from "../evaluationExpiry.js";
import { backfillSecurityStatePage } from "../securityStateMigration.js";
import { readOpportunityProposalLockRepair } from "../opportunityProposalLocks.js";
import { memoryDb } from "./memoryDb.mjs";
import { hasAttachedPublicationSchema } from "../attachedProposalSchema.js";

const wallet = `0x${"a".repeat(40)}`, now = new Date("2026-11-05T12:00:00Z");

it("marks only the exact attached key schema and valid optional metadata", () => {
  const content = { researcherId: wallet, problemId: "parent", status: "submitted", title: "Title", aiAssisted: true };
  assert.equal(hasAttachedPublicationSchema(content), true);
  for (const extra of [{ injected: "unknown" }, { matching: {} }, { moderationStatus: "visible" },
    { audit: {} }, { createdAt: now }, { proposalKind: "independent" }, { aiAssisted: "true" },
    { reviewedParentAudit: {} }]) assert.equal(hasAttachedPublicationSchema({ ...content, ...extra }), false);
});

it("normalizes legacy evaluation statuses with exact trim/lower/missing semantics and retains IDs", async () => {
  const statuses = [undefined, null, "", " ACCEPTED ", "AcCePtEd", "accepted", "submitted", "rejected", "not accepted"];
  const initial = Object.fromEntries(statuses.map((status, index) => [`evaluations/arbitrary.legacy-${index}`, {
    proposalId: `proposal-${index}`, evaluatorId: wallet, ...(status !== undefined ? { status } : {}),
  }]));
  const db = memoryDb(initial);
  const first = await backfillSecurityStatePage({ db, now, kind: "evaluations", pageSize: 3 });
  assert.equal(first.done, false);
  assert.equal(db.records.get("maintenanceState/evaluationExpiryV1").ready, false);
  while (!(await backfillSecurityStatePage({ db, now, kind: "evaluations", pageSize: 3 })).done) {}
  assert.equal(db.records.get("maintenanceState/evaluationExpiryV1").ready, true);
  for (let index = 0; index < statuses.length; index++) {
    const original = initial[`evaluations/arbitrary.legacy-${index}`];
    assert.equal(db.records.get(`evaluations/arbitrary.legacy-${index}`).expiryAccepted, evaluationExpiryAccepted(original));
    assert.equal(db.records.get(`evaluationSlots/${evaluationSlotId(original.proposalId, wallet)}`).evaluationId, `arbitrary.legacy-${index}`);
    assert.equal(db.records.get(`evaluations/arbitrary.legacy-${index}`).status, statuses[index]);
  }
  assert.deepEqual(await backfillSecurityStatePage({ db, now, kind: "evaluations" }), { kind: "evaluations", done: true, scanned: 0 });
});

it("retains duplicate legacy evaluations while permanently occupying their shared pair slot", async () => {
  const db = memoryDb({
    "evaluations/first": { proposalId: "legacy.proposal", evaluatorId: wallet, status: "accepted" },
    "evaluations/second": { proposalId: "legacy.proposal", evaluatorId: wallet },
  });
  await backfillSecurityStatePage({ db, now, kind: "evaluations" });
  assert.equal(db.records.get(`evaluationSlots/legacy.proposal_${wallet}`).evaluationId, "first");
  assert.equal(db.records.get("evaluations/first").expiryAccepted, true);
  assert.equal(db.records.get("evaluations/second").expiryAccepted, false);
});

it("backfills and repairs immutable parent locks without locking unpublished requests or abandoned drafts", async () => {
  const db = memoryDb({
    "proposals/submitted": { problemId: "parent", researcherId: wallet, status: "submitted", createdAt: now },
    "proposals/second": { problemId: "parent", researcherId: wallet, status: "accepted" },
    "proposals/draft": { problemId: "draft-parent", researcherId: wallet, status: "draft" },
    "proposals/abandoned": { problemId: "abandoned-parent", researcherId: wallet, status: "withdrawn" },
    "proposals/withdrawn": { problemId: "withdrawn-parent", researcherId: wallet, status: "withdrawn", audit: { transactionHash: "0xreceipt" } },
    "proposals/hidden": { problemId: "hidden-parent", researcherId: wallet, status: "moderated_hidden", audit: { transactionHash: "0xreceipt" } },
    "proposals/removed": { problemId: "removed-parent", researcherId: wallet, status: "moderated_removed", audit: { transactionHash: "0xreceipt" } },
    "proposals/hidden-draft": { problemId: "hidden-draft-parent", researcherId: wallet, status: "moderated_hidden" },
  });
  const result = await backfillSecurityStatePage({ db, now, kind: "proposal-locks" });
  assert.equal(result.done, true);
  assert.equal(db.records.get("maintenanceState/opportunityProposalLocksV1").ready, true);
  assert.equal(db.records.has("opportunityProposalLocks/parent"), true);
  assert.equal(db.records.has("opportunityProposalLocks/withdrawn-parent"), true);
  assert.equal(db.records.has("opportunityProposalLocks/hidden-parent"), true);
  assert.equal(db.records.has("opportunityProposalLocks/removed-parent"), true);
  assert.equal(db.records.has("opportunityProposalLocks/hidden-draft-parent"), false);
  assert.equal(db.records.has("opportunityProposalLocks/draft-parent"), false);
  assert.equal(db.records.has("opportunityProposalLocks/abandoned-parent"), false);
  const original = db.records.get("opportunityProposalLocks/parent");
  await db.runTransaction(async tx => {
    const repair = await readOpportunityProposalLockRepair({ tx, db, recordId: "different", storedRecord: {
      problemId: "parent", researcherId: wallet, status: "submitted",
    }, now });
    repair();
  });
  assert.deepEqual(db.records.get("opportunityProposalLocks/parent"), original);
  await db.runTransaction(async tx => (await readOpportunityProposalLockRepair({ tx, db,
    recordId: "unpublished", storedRecord: null, now }))());
  assert.equal(db.records.has("opportunityProposalLocks/unpublished"), false);
});
