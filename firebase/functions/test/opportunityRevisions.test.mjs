import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TRACKED_POSTING_FIELDS,
  changedOpportunityFields,
  opportunityRevisionEntry,
  recordOpportunityRevision,
} from "../opportunityRevisions.js";

const OWNER = `0x${"81".repeat(20)}`;
const at = new Date("2026-09-08T10:00:00Z");

function posting(overrides = {}) {
  return {
    ownerId: OWNER, organisation: "SMU", title: "Cold-chain routing",
    summary: "Routing degrades under demand spikes", businessContext: "Logistics",
    currentApproach: "Heuristic", currentLimitations: "Runtime", expectedOutcome: "Faster",
    successCriteria: "10 percent", dataAvailability: "Telemetry",
    categories: ["ai"], amount: 80000, currency: "USDT",
    expiresAt: new Date("2026-12-01T00:00:00Z"), status: "submitted", attachments: [],
    ...overrides,
  };
}

function fakeDb(sink) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id) => ({ set: async (entry) => { sink.push({ id, entry }); } }),
        }),
      }),
    }),
  };
}

describe("QCDAO-57 opportunity edit trail", () => {
  it("names the fields that moved and ignores receipt delivery", () => {
    const before = posting();
    assert.deepEqual(changedOpportunityFields(before, posting({ title: "Retitled" })), ["title"]);
    for (const noise of [{ audit: { status: "pending" } }, { updatedAt: at }]) {
      assert.deepEqual(changedOpportunityFields(before, posting(noise)), []);
    }
    assert.ok(!TRACKED_POSTING_FIELDS.includes("audit"));
  });

  it("records the actor, timestamp, hashes and withdrawal reason", () => {
    const entry = opportunityRevisionEntry({
      recordId: "posting1", before: posting(), after: posting({ title: "Retitled" }), at,
    });
    assert.deepEqual(entry.changedFields, ["title"]);
    assert.equal(entry.actor, OWNER);
    assert.equal(entry.at, at);
    assert.match(entry.contentHashBefore, /^0x[0-9a-f]{64}$/);
    assert.notEqual(entry.contentHashBefore, entry.contentHashAfter);

    const withdrawn = opportunityRevisionEntry({
      recordId: "posting1",
      before: posting(),
      after: posting({ status: "cancelled", withdrawalReason: "The budget was withdrawn." }),
      at,
    });
    assert.equal(withdrawn.status, "cancelled");
    assert.equal(withdrawn.withdrawalReason, "The budget was withdrawn.");
  });

  it("writes nothing for a create, a delete, a draft save or a receipt update", async () => {
    const written = [];
    const db = fakeDb(written);
    const run = (before, after) => recordOpportunityRevision({
      db, recordId: "posting1", eventId: "event1", before, after, at,
    });
    assert.equal(await run(undefined, posting()), null);
    assert.equal(await run(posting(), undefined), null);
    assert.equal(await run(posting({ status: "draft" }), posting({ status: "draft", title: "Later" })), null);
    assert.equal(await run(posting(), posting({ audit: { status: "confirmed" } })), null);
    assert.deepEqual(written, []);
  });
});
