import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TRACKED_PROPOSAL_FIELDS,
  changedProposalFields,
  proposalRevisionEntry,
  recordProposalRevision,
} from "../proposalRevisions.js";

const AUTHOR = `0x${"81".repeat(20)}`;
const SPONSOR = `0x${"91".repeat(20)}`;
const at = new Date("2026-09-08T10:00:00Z");

function proposal(overrides = {}) {
  return {
    researcherId: AUTHOR, postingOwnerId: SPONSOR, problemId: "problem1",
    opportunityType: "business-problem", title: "Annealing routing",
    summary: "A measurable routing study", category: "quantum-annealing",
    methodology: "Compare annealing against a classical baseline",
    suitability: "A combinatorial routing problem", expectedOutcomes: "Improved routing",
    successCriteria: "10 percent less travel", timeline: "12 weeks",
    milestones: "Baseline, prototype, validation", team: "Operations research team",
    amount: 1500, currency: "USDC", status: "submitted", attachments: [],
    ...overrides,
  };
}

/** Collects what a trigger run would have written, without an emulator. */
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

describe("QCDAO-57 proposal edit trail", () => {
  it("names the fields that moved and ignores receipt delivery", () => {
    const before = proposal();
    assert.deepEqual(changedProposalFields(before, proposal({ timeline: "16 weeks" })), ["timeline"]);
    assert.deepEqual(
      changedProposalFields(before, proposal({ title: "Retitled", amount: 1600 })).sort(),
      ["amount", "title"],
    );
    // The receipt advances on its own several times per submission. Treating
    // that as an edit would bury the entries a dispute actually turns on.
    for (const noise of [{ audit: { status: "pending" } }, { updatedAt: at }, { withdrawalReason: "x" }]) {
      assert.deepEqual(changedProposalFields(before, proposal(noise)), []);
    }
    assert.ok(!TRACKED_PROPOSAL_FIELDS.includes("audit"));
  });

  it("compares attachments by content, not by key order or identity", () => {
    const file = { id: "file0001", name: "support.pdf", size: 200, contentType: "application/pdf" };
    const reordered = { contentType: "application/pdf", size: 200, name: "support.pdf", id: "file0001" };
    const before = proposal({ attachments: [file] });
    assert.deepEqual(changedProposalFields(before, proposal({ attachments: [reordered] })), []);
    assert.deepEqual(changedProposalFields(before, proposal({ attachments: [] })), ["attachments"]);
    assert.deepEqual(changedProposalFields(before, proposal({ attachments: [{ ...file, size: 300 }] })), ["attachments"]);
  });

  it("records the actor, the timestamp and both content hashes for a correction", () => {
    const entry = proposalRevisionEntry({
      proposalId: "proposal1", before: proposal(), after: proposal({ timeline: "16 weeks" }), at,
    });
    assert.deepEqual(entry.changedFields, ["timeline"]);
    // A Firestore trigger carries no auth context. Only the author may write
    // these fields, so the stored researcherId is the actor by construction.
    assert.equal(entry.actor, AUTHOR);
    assert.equal(entry.postingOwnerId, SPONSOR);
    assert.equal(entry.at, at);
    assert.equal(entry.previousStatus, "submitted");
    assert.equal(entry.status, "submitted");
    assert.match(entry.contentHashBefore, /^0x[0-9a-f]{64}$/);
    assert.match(entry.contentHashAfter, /^0x[0-9a-f]{64}$/);
    assert.notEqual(entry.contentHashBefore, entry.contentHashAfter);
    assert.ok(!("withdrawalReason" in entry));
  });

  it("keeps the stated reason with the withdrawal that used it", () => {
    const entry = proposalRevisionEntry({
      proposalId: "proposal1",
      before: proposal(),
      after: proposal({ status: "withdrawn", withdrawalReason: "The costing was wrong." }),
      at,
    });
    assert.equal(entry.status, "withdrawn");
    assert.equal(entry.previousStatus, "submitted");
    assert.equal(entry.withdrawalReason, "The costing was wrong.");
    assert.deepEqual(entry.changedFields, []);
  });

  it("writes nothing for a create, a delete, a draft save or a receipt update", async () => {
    const written = [];
    const db = fakeDb(written);
    const run = (before, after) => recordProposalRevision({
      db, proposalId: "proposal1", eventId: "event1", before, after, at,
    });
    assert.equal(await run(undefined, proposal()), null);
    assert.equal(await run(proposal(), undefined), null);
    // Drafts are private and rewritten by design; that is what drafting is for.
    assert.equal(await run(proposal({ status: "draft" }), proposal({ status: "draft", title: "Second sitting" })), null);
    assert.equal(await run(proposal({ status: "draft" }), proposal()), null);
    assert.equal(await run(proposal(), proposal({ audit: { status: "confirmed" } })), null);
    assert.deepEqual(written, []);
  });

  it("keys the entry on the event so a retried trigger cannot double-count", async () => {
    const written = [];
    const db = fakeDb(written);
    const run = () => recordProposalRevision({
      db, proposalId: "proposal1", eventId: "event1",
      before: proposal(), after: proposal({ team: "A larger team" }), at,
    });
    await run();
    await run();
    assert.equal(written.length, 2);
    assert.deepEqual(written.map(({ id }) => id), ["event1", "event1"]);
    assert.deepEqual(written[0].entry.changedFields, ["team"]);
  });
});
