import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { encodeFunctionData } from "viem";
import { verifyPublication } from "../publication.js";
import { verifyMinedProposal } from "../proposalAuditRecovery.js";
import { prepareOpportunityCommit } from "../auditCanonical.js";
import { prepareStoredProposal } from "../proposalAuditPayload.js";
import { postingAuditPayload, fundingOpportunityAuditPayload } from "../opportunityAuditPayload.js";
import { resolveAuditDeployment } from "../auditDeployments.js";
import { proposalReceiptEvent } from "../auditReceipt.js";
import registry from "../auditRegistry.contract.json" with { type: "json" };
import { auditEvent, AUDIT_REVISION_DIGEST } from "./auditEvent.mjs";
import { escrowRecord, escrowClient, escrowConfig, researcher, owner, txHash, blockHash } from "./fixtures/escrowAuditFixture.js";

const otherAddress = `0x${"e".repeat(40)}`;
const otherHash = `0x${"f".repeat(64)}`;
// Deliberately opaque account calldata: it is neither execute/executeBatch nor
// handleOps. Confirmation must depend on the mined registry effect instead.
const opaqueTransaction = { from: otherAddress, to: `0x${"9".repeat(40)}`, input: "0xdeadbeef01234567" };

function opportunityFixture(funding = false, update = false, direct = false) {
  const record = { id: "sponsored-posting", ownerId: owner, title: "Routing", summary: "Research",
    amount: 1000, currency: "USDC", status: "submitted", attachments: [],
    expiresAt: Timestamp.fromDate(new Date("2099-01-01")),
    ...(funding ? { opportunityType: "open-funding", fundingThesis: "Resilience" } : {}),
    audit: { transactionHash: txHash, chainId: registry.chainId } };
  const expected = prepareOpportunityCommit({ actor: registry.entityIdScheme === 2 ? owner : undefined,
    recordId: record.id, kind: funding ? 1 : 0, expiresAt: record.expiresAt,
    payload: funding ? fundingOpportunityAuditPayload(record) : postingAuditPayload(record) });
  const functionName = update ? "updateOpportunity" : "commitOpportunity";
  const args = update ? [expected.entityId, expected.contentHash, expected.args[3]] : expected.args;
  const receipt = { transactionHash: txHash, status: "success", blockNumber: 88n, blockHash,
    logs: [auditEvent({ config: registry, functionName, args, actor: owner })] };
  const transaction = { hash: txHash, chainId: registry.chainId, blockNumber: 88n, blockHash,
    ...(direct ? { from: owner, to: registry.address, input: encodeFunctionData({ abi: registry.abi, functionName, args }) }
      : opaqueTransaction) };
  const actual = { owner, kind: expected.args[1], contentHash: expected.contentHash,
    expiresAt: expected.args[3], withdrawn: false };
  const client = { getTransactionReceipt: async () => receipt, getTransaction: async () => transaction,
    getBlock: async ({ blockNumber }) => blockNumber === 88n ? { hash: blockHash } : { parentHash: blockHash },
    readContract: async () => actual };
  return { record, expected, receipt, transaction, actual, client };
}

async function proposalFixture({ revision = 0, direct = false } = {}) {
  const record = escrowRecord();
  const expected = prepareStoredProposal(record, { registryConfig: escrowConfig });
  const client = escrowClient(record);
  const receipt = await client.getTransactionReceipt();
  const transaction = { ...await client.getTransaction(), ...(!direct ? opaqueTransaction : {}) };
  const args = [...expected.args];
  args[4] = revision;
  receipt.logs = [auditEvent({ config: escrowConfig, functionName: expected.functionName, args, actor: researcher })];
  const read = client.readContract;
  client.readContract = async request => {
    const actual = await read(request);
    return request.functionName === "getProposal" ? { ...actual, opportunityRevisionIndex: revision } : actual;
  };
  client.getTransactionReceipt = async () => receipt;
  client.getTransaction = async () => transaction;
  return { record, expected, receipt, transaction, client };
}

const verifyOpportunity = fixture => verifyPublication({ scope: "problems", record: fixture.record, client: fixture.client });
const verifyProposal = fixture => verifyMinedProposal(fixture.record, fixture.client, { registryConfig: escrowConfig });

describe("QCDAO-145 mined event proof for sponsored audits", () => {
  for (const funding of [false, true]) for (const update of [false, true]) {
    it(`confirms opaque sponsored ${funding ? "open funding" : "problem"} ${update ? "updates" : "commits"}`, async () => {
      const fixture = opportunityFixture(funding, update);
      const confirmed = await verifyOpportunity(fixture);
      assert.equal(confirmed.status, "confirmed");
      assert.equal(confirmed.entityId, fixture.expected.entityId);
      assert.equal(confirmed.blockNumber, 88);
    });
  }

  it("confirms an opaque sponsored proposal and still verifies its deployed escrow", async () => {
    const fixture = await proposalFixture();
    assert.equal((await verifyProposal(fixture)).status, "confirmed");
    assert.ok(fixture.client.calls.some(call => call.functionName === "proposalEscrow"));
    assert.ok(fixture.client.calls.some(call => call.functionName === "escrowForProposal"));
    const read = fixture.client.readContract;
    fixture.client.readContract = async request => request.functionName === "fundingTarget" ? 1n : read(request);
    await assert.rejects(verifyProposal(fixture), /Mismatch|escrow/i);
  });

  it("keeps direct wallet publications and proposals working", async () => {
    assert.equal((await verifyOpportunity(opportunityFixture(false, false, true))).status, "confirmed");
    assert.equal((await verifyProposal(await proposalFixture({ direct: true }))).status, "confirmed");
  });

  it("finds the exact operation among unrelated emitters, malformed logs and other records", async () => {
    const opportunity = opportunityFixture(true);
    const another = auditEvent({ config: registry, functionName: "commitOpportunity", actor: owner,
      args: [otherHash, ...opportunity.expected.args.slice(1)] });
    opportunity.receipt.logs = [{ address: otherAddress, topics: [], data: "0x" },
      { ...opportunity.receipt.logs[0], data: "0x00" }, another, opportunity.receipt.logs[0], another];
    assert.equal((await verifyOpportunity(opportunity)).status, "confirmed");
    const proposal = await proposalFixture();
    const otherArgs = [...proposal.expected.args]; otherArgs[0] = otherHash;
    proposal.receipt.logs = [auditEvent({ config: escrowConfig, functionName: proposal.expected.functionName,
      args: otherArgs, actor: researcher }), ...opportunity.receipt.logs, proposal.receipt.logs[0]];
    assert.equal((await verifyProposal(proposal)).status, "confirmed");
  });

  const opportunityCases = {
    "missing event": fixture => [],
    "wrong emitter": fixture => [{ ...fixture.receipt.logs[0], address: otherAddress }],
    "wrong actor": fixture => [auditEvent({ config: registry, functionName: "commitOpportunity", args: fixture.expected.args, actor: otherAddress })],
    "wrong entity": fixture => [auditEvent({ config: registry, functionName: "commitOpportunity", args: [otherHash, ...fixture.expected.args.slice(1)], actor: owner })],
    "wrong content hash": fixture => [auditEvent({ config: registry, functionName: "commitOpportunity", args: [fixture.expected.entityId, fixture.expected.args[1], otherHash, fixture.expected.args[3]], actor: owner })],
    "wrong kind": fixture => [auditEvent({ config: registry, functionName: "commitOpportunity", args: [fixture.expected.entityId, 1, ...fixture.expected.args.slice(2)], actor: owner })],
    "wrong expiry": fixture => [auditEvent({ config: registry, functionName: "commitOpportunity", args: [...fixture.expected.args.slice(0, 3), fixture.expected.args[3] + 1n], actor: owner })],
    "malformed event": fixture => [{ ...fixture.receipt.logs[0], data: "0x01" }],
    "withdrawal only": fixture => [auditEvent({ config: registry, functionName: "withdrawOpportunity", args: [fixture.expected.entityId, fixture.expected.contentHash], actor: owner })],
    "removed event": fixture => [{ ...fixture.receipt.logs[0], removed: true }],
    "log from another transaction": fixture => [{ ...fixture.receipt.logs[0], transactionHash: otherHash }],
    "log from another block": fixture => [{ ...fixture.receipt.logs[0], blockHash: otherHash }],
    "log with another block number": fixture => [{ ...fixture.receipt.logs[0], blockNumber: 89n }],
  };
  for (const [reason, logs] of Object.entries(opportunityCases)) {
    it(`refuses a sponsored publication with ${reason}`, async () => {
      const fixture = opportunityFixture(); fixture.receipt.logs = logs(fixture);
      await assert.rejects(verifyOpportunity(fixture), /differs/);
    });
  }

  const proposalCases = {
    "missing event": fixture => [],
    "wrong emitter": fixture => [{ ...fixture.receipt.logs[0], address: otherAddress }],
    "wrong actor": fixture => [auditEvent({ config: escrowConfig, functionName: fixture.expected.functionName, args: fixture.expected.args, actor: owner })],
    "wrong entity": fixture => {
      const args = [...fixture.expected.args]; args[0] = otherHash;
      return [auditEvent({ config: escrowConfig, functionName: fixture.expected.functionName, args, actor: researcher })];
    },
    "wrong parent": fixture => {
      const args = [...fixture.expected.args]; args[1] = otherHash;
      return [auditEvent({ config: escrowConfig, functionName: fixture.expected.functionName, args, actor: researcher })];
    },
    "wrong proposal hash": fixture => {
      const args = [...fixture.expected.args]; args[2] = otherHash;
      return [auditEvent({ config: escrowConfig, functionName: fixture.expected.functionName, args, actor: researcher })];
    },
    "wrong solution hash": fixture => {
      const args = [...fixture.expected.args]; args[3] = otherHash;
      return [auditEvent({ config: escrowConfig, functionName: fixture.expected.functionName, args, actor: researcher })];
    },
    "malformed event": fixture => [{ ...fixture.receipt.logs[0], data: "0x01" }],
    "withdrawal only": fixture => [auditEvent({ config: escrowConfig, functionName: "withdrawProposal", args: [fixture.expected.entityId, fixture.expected.contentHash], actor: researcher })],
  };
  for (const [reason, logs] of Object.entries(proposalCases)) {
    it(`refuses a sponsored proposal with ${reason}`, async () => {
      const fixture = await proposalFixture(); fixture.receipt.logs = logs(fixture);
      await assert.rejects(verifyProposal(fixture), /Mismatch|known/);
    });
  }

  it("uses the mined nonzero parent revision and binds its digest to current proposal state", async () => {
    const fixture = await proposalFixture({ revision: 3 });
    assert.equal((await verifyProposal(fixture)).status, "confirmed");
    const read = fixture.client.readContract;
    fixture.client.readContract = async request => request.functionName === "getProposal"
      ? { ...await read(request), opportunityRevisionDigest: otherHash } : read(request);
    assert.notEqual(AUDIT_REVISION_DIGEST, otherHash);
    await assert.rejects(verifyProposal(fixture), /current proposal differs/);
    fixture.client.readContract = async request => request.functionName === "getProposal"
      ? { ...await read(request), opportunityRevisionIndex: 0 } : read(request);
    await assert.rejects(verifyProposal(fixture), /current proposal differs/);
  });

  for (const kind of ["opportunity", "proposal"]) {
    for (const [reason, mutate] of Object.entries({
      "wrong chain": fixture => { fixture.transaction.chainId = 1; },
      "wrong receipt hash": fixture => { fixture.receipt.transactionHash = otherHash; },
      "wrong transaction hash": fixture => { fixture.transaction.hash = otherHash; },
      "reverted execution": fixture => { fixture.receipt.status = "reverted"; },
      "different transaction block": fixture => { fixture.transaction.blockNumber = 89n; },
      "different transaction block hash": fixture => { fixture.transaction.blockHash = otherHash; },
      "noncanonical block": fixture => { fixture.client.getBlock = async () => ({ hash: otherHash, parentHash: blockHash }); },
      "missing next confirmation": fixture => { fixture.client.getBlock = async () => ({ hash: blockHash, parentHash: otherHash }); },
    })) {
      it(`preserves ${kind} finality rejection for ${reason}`, async () => {
        const fixture = kind === "opportunity" ? opportunityFixture() : await proposalFixture();
        mutate(fixture);
        await assert.rejects(kind === "opportunity" ? verifyOpportunity(fixture) : verifyProposal(fixture));
      });
    }
  }

  it("refuses a publication whose current registry state was changed or withdrawn", async () => {
    for (const patch of [{ owner: otherAddress }, { contentHash: otherHash }, { kind: 1 }, { expiresAt: 1n }, { withdrawn: true }]) {
      const fixture = opportunityFixture(); Object.assign(fixture.actual, patch);
      await assert.rejects(verifyOpportunity(fixture), /current audit registry record/);
    }
  });

  it("rejects an unknown deployment and ambiguous matching registry effects", async () => {
    const fixture = await proposalFixture();
    const second = { ...escrowConfig, address: otherAddress };
    const matchesReceipt = config => proposalReceiptEvent(fixture.receipt, config,
      prepareStoredProposal(fixture.record, { registryConfig: config }), researcher);
    fixture.receipt.logs = [{ ...fixture.receipt.logs[0], address: otherAddress }];
    await assert.rejects(resolveAuditDeployment(fixture.record, { activeConfig: escrowConfig, history: [],
      receipt: fixture.receipt, transaction: fixture.transaction, matchesReceipt }), /known, unambiguous/);
    fixture.receipt.logs.push(auditEvent({ config: escrowConfig, functionName: fixture.expected.functionName,
      args: fixture.expected.args, actor: researcher }));
    await assert.rejects(resolveAuditDeployment(fixture.record, { activeConfig: escrowConfig, history: [second],
      receipt: fixture.receipt, transaction: fixture.transaction, matchesReceipt }), /known, unambiguous/);
  });
});
