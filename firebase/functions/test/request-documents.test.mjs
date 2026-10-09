import assert from "node:assert/strict";
import { it } from "node:test";
import { createRequestDocumentReader } from "../requestDocuments.js";
import { memoryDb } from "./memoryDb.mjs";
import { loadFundingContext } from "../escrowFunding.js";
import { openFundingFixture, owner } from "./fixtures/openFundingFixture.js";

it("reuses request-local profile/parent reads while preserving every proposal's authorization", async () => {
  const f = openFundingFixture(), readDocument = createRequestDocumentReader();
  readDocument.prime((await f.db.collection("proposals").get()).docs);
  const contexts = await Promise.all(f.proposals.map(proposal => loadFundingContext({ ...f, uid: owner, proposalId: proposal.id, readDocument })));
  assert.equal(contexts.length, 2);
  assert.equal(f.db.reads, 2); // One profile and one shared parent, not per proposal.
  f.db.records.set(`users/${owner}`, { role: 0, suspended: true });
  await assert.rejects(loadFundingContext({ ...f, uid: owner, proposalId: f.proposals[0].id,
    readDocument: createRequestDocumentReader() }), /not available/);
});

it("does not retain failed reads and separates missing documents by path", async () => {
  const db = memoryDb(), readDocument = createRequestDocumentReader();
  let attempts = 0;
  const ref = { path: "users/retry", get: async () => {
    if (++attempts === 1) throw new Error("unavailable");
    return db.collection("users").doc("retry").get();
  } };
  await assert.rejects(readDocument(ref), /unavailable/);
  assert.equal((await readDocument(ref)).exists, false);
  assert.equal((await readDocument(db.collection("users").doc("other"))).exists, false);
  assert.equal(attempts, 2); assert.equal(db.reads, 2);
});
