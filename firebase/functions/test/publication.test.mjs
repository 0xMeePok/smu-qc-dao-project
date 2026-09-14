import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData } from "viem";
import { Timestamp } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { verifyPublication } from "../publication.js";
import { prepareOpportunityCommit, prepareProposalCommit, opportunityEntityId } from "../auditCanonical.js";
import { postingAuditPayload, fundingOpportunityAuditPayload } from "../opportunityAuditPayload.js";
import registry from "../auditRegistry.contract.json" with { type: "json" };
const owner = `0x${"a".repeat(40)}`, hash = `0x${"1".repeat(64)}`, blockHash = `0x${"2".repeat(64)}`;
function fixture(openFunding = false) {
  return { id: "trusted-publication", ownerId: owner, title: "Routing", summary: "Research", amount: 1000, currency: "USDC",
    expiresAt: Timestamp.fromDate(new Date("2099-01-01")), status: "submitted", attachments: [],
    ...(openFunding ? { opportunityType: "open-funding", fundingThesis: "Resilience" } : {}),
    audit: { transactionHash: hash } };
}
function clientFor(record, update = false, legacy = false) {
  const funding = record.opportunityType === "open-funding";
  const expected = prepareOpportunityCommit({ actor: !legacy && registry.entityIdScheme === 2 ? record.ownerId : undefined, recordId: record.id, expiresAt: record.expiresAt, kind: funding ? 1 : 0,
    payload: funding ? fundingOpportunityAuditPayload(record) : postingAuditPayload(record) });
  return {
    getTransactionReceipt: async () => ({ transactionHash: hash, status: "success", blockHash, blockNumber: 10n }),
    getTransaction: async () => ({ hash, to: registry.address, from: owner, chainId: 421614, blockHash, blockNumber: 10n,
      input: encodeFunctionData({ abi: registry.abi, functionName: update ? "updateOpportunity" : "commitOpportunity",
        args: update ? [expected.entityId, expected.contentHash, expected.args[3]] : expected.args }) }),
    getBlock: async ({ blockNumber }) => blockNumber === 10n ? { hash: blockHash } : { parentHash: blockHash },
    readContract: async () => ({ owner, contentHash: expected.contentHash, kind: expected.args[1], expiresAt: expected.args[3], withdrawn: false }),
  };
}
describe("QCDAO-131 trusted publication boundary", () => {
  for (const funding of [false, true]) for (const update of [false, true]) it(`verifies ${funding ? "funding" : "problem"} ${update ? "correction" : "publication"}`, async () => {
    const record = fixture(funding);
    assert.equal((await verifyPublication({ scope: "problems", record, client: clientFor(record, update) })).status, "confirmed");
  });
  it("rejects legacy entity IDs under the replacement registry", async () => {
    const record = fixture();
    assert.equal(registry.entityIdScheme, 2);
    await assert.rejects(verifyPublication({ scope: "problems", record, client: clientFor(record, false, true) }), /differs/);
  });
  it("refuses missing proof, changed content, wrong sender/chain/registry and reverted transactions", async () => {
    const record = fixture(), client = clientFor(record);
    await assert.rejects(verifyPublication({ scope: "problems", record: { ...record, audit: {} }, client }));
    await assert.rejects(verifyPublication({ scope: "problems", record: { ...record, title: "Changed" }, client }));
    for (const patch of [{ from: `0x${"b".repeat(40)}` }, { to: `0x${"b".repeat(40)}` }, { chainId: 1 }]) {
      await assert.rejects(verifyPublication({ scope: "problems", record,
        client: { ...client, getTransaction: async () => ({ ...await client.getTransaction(), ...patch }) } }));
    }
    await assert.rejects(verifyPublication({ scope: "problems", record,
      client: { ...client, getTransactionReceipt: async () => ({ ...await client.getTransactionReceipt(), status: "reverted" }) } }));
  });
  it("rejects reorgs, withdrawn registry records and replaced attachment bytes", async () => {
    const record = fixture(), client = clientFor(record);
    await assert.rejects(verifyPublication({ scope: "problems", record, client: { ...client, getBlock: async () => ({ hash: "bad", parentHash: "bad" }) } }));
    await assert.rejects(verifyPublication({ scope: "problems", record, client: { ...client, readContract: async () => ({ ...await client.readContract(), withdrawn: true }) } }));
    const bytes = Buffer.from("%PDF-1.7\noriginal");
    record.attachments = [{ id: "evidence01", name: "proof.pdf", size: bytes.length, contentType: "application/pdf",
      sha256: `0x${createHash("sha256").update(bytes).digest("hex")}` }];
    assert.equal((await verifyPublication({ scope: "problems", record, client: clientFor(record), readAttachment: async () => bytes })).status, "confirmed");
    await assert.rejects(verifyPublication({ scope: "problems", record, client: clientFor(record), readAttachment: async () => Buffer.from("%PDF-1.7\nreplaced") }));
  });
});
it("QCDAO-137 preserves legacy IDs and prepares actor-scoped contract calls explicitly", () => {
  const record = fixture();
  const legacy = opportunityEntityId(record.id);
  const scoped = opportunityEntityId(record.id, { actor: owner });
  assert.notEqual(scoped, legacy);
  assert.equal(scoped.slice(0, 42), owner);
  const operation = prepareOpportunityCommit({ recordId: record.id, payload: postingAuditPayload(record), expiresAt: record.expiresAt, actor: owner });
  assert.equal(operation.args[0], scoped);
  const proposal = prepareProposalCommit({ recordId: "proposal", opportunityRecordId: record.id, actor: owner, opportunityActor: owner,
    proposalPayload: { researcherId: owner }, solutionPayload: {}, expectedOpportunityRevisionIndex: 1 });
  assert.equal(proposal.entityId.slice(0, 42), owner);
  assert.equal(proposal.opportunityId, scoped);
  assert.equal(opportunityEntityId(record.id), legacy);
});
