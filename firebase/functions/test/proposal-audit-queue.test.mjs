import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { proposalAuditQueueMetadata } from "../proposalAuditQueue.js";
import { prepareStoredProposal } from "../proposalAuditPayload.js";

const record = () => ({ proposalKind: "independent", researcherId: `0x${"a".repeat(40)}`,
  title: "Independent quantum library", category: "quantum-adjacent", amount: 2, currency: "USDT",
  summary: "Reusable scheduling library", methodology: "Hybrid simulation", addressedProblems: "Scheduling",
  maturity: "concept", team: "Research team", status: "submitted", expiresAt: Timestamp.fromMillis(2000000000000),
  audit: { schemaVersion: 1, status: "failed", transactionHash: `0x${"3".repeat(64)}`, attemptCount: 3 } });

describe("admin proposal audit queue metadata", () => {
  it("identifies an independent publication using its scheme 2 opportunity receipt", () => {
    const data = record(), prepared = prepareStoredProposal({ ...data, id: "independent-listing" });
    const metadata = proposalAuditQueueMetadata("independent-listing", data);
    assert.equal(metadata.proposalKind, "independent");
    assert.equal(metadata.problemId, null);
    assert.equal(prepared.functionName, "commitOpportunity");
    assert.equal(metadata.audit.schemaVersion, 2);
    assert.equal(metadata.audit.entityId, prepared.entityId);
    assert.equal(metadata.audit.contentHash, prepared.contentHash);
    assert.equal(metadata.audit.solutionHash, undefined);
    assert.equal(metadata.audit.status, "failed");
    assert.equal(metadata.audit.attemptCount, 3);
    assert.equal(metadata.audit.transactionHash, data.audit.transactionHash);
    assert.equal(data.audit.schemaVersion, 1);
  });

  it("retains independent context even when legacy parent metadata or malformed content is present", () => {
    const data = { ...record(), problemId: "legacy-parent", expiresAt: null };
    const metadata = proposalAuditQueueMetadata("independent-listing", data);
    assert.equal(metadata.proposalKind, "independent");
    assert.equal(metadata.problemId, null);
    assert.equal(metadata.audit, null);
  });

  it("preserves the parent reference for attached proposals and handles deleted records", () => {
    const metadata = proposalAuditQueueMetadata("attached", { problemId: "parent", audit: null });
    assert.equal(metadata.proposalKind, null);
    assert.equal(metadata.problemId, "parent");
    assert.deepEqual(proposalAuditQueueMetadata("deleted", undefined), { audit: null, proposalKind: null, problemId: null });
  });
});
