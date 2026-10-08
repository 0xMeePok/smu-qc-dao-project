import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { encodeFunctionData } from "viem";
import { Timestamp } from "firebase-admin/firestore";
import registry from "../auditRegistry.contract.json" with { type: "json" };
import { prepareStoredProposal } from "../proposalAuditPayload.js";
import { verifyPublication } from "../publication.js";
import { enqueueProposalAudit, recoverProposalAudit, verifyMinedProposal } from "../proposalAuditRecovery.js";

const researcher = `0x${"a".repeat(40)}`;
const hash = `0x${"3".repeat(64)}`;
const blockHash = `0x${"4".repeat(64)}`;
const now = Timestamp.fromMillis(1_800_000_000_000);
const listing = (patch = {}) => ({
  id: "independent-audit-listing", proposalKind: "independent", researcherId: researcher,
  title: "Independent quantum routing", summary: "A routing capability seeking a funder",
  methodology: "Hybrid annealing", addressedProblems: "Last-mile routing", category: "quantum-adjacent",
  maturity: "pilot", team: "Two researchers", amount: 990, currency: "USDC",
  expiresAt: Timestamp.fromMillis(now.toMillis() + 90 * 864e5), status: "submitted", attachments: [],
  audit: { schemaVersion: 2, chainId: registry.chainId, status: "pending", transactionHash: hash,
    entityId: "", contentHash: "", attemptCount: 1, blockNumber: 0, lastError: "" },
  ...patch,
});

function clientFor(record, { config = registry, update = false } = {}) {
  const expected = prepareStoredProposal(record, { registryConfig: config });
  const calls = [];
  return {
    calls,
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 88n, blockHash, transactionHash: hash }),
    getTransaction: async () => ({ hash, to: config.address, from: researcher, chainId: config.chainId,
      blockNumber: 88n, blockHash, input: encodeFunctionData({ abi: config.abi,
        functionName: update ? "updateOpportunity" : "commitOpportunity",
        args: update ? [expected.entityId, expected.contentHash, expected.args[3]] : expected.args }) }),
    getBlock: async ({ blockNumber }) => blockNumber === 88n ? { hash: blockHash }
      : { hash: `0x${"5".repeat(64)}`, parentHash: blockHash },
    readContract: async (request) => {
      calls.push(request);
      assert.equal(request.functionName, "getOpportunity", "independent publication must not require a child Proposal or escrow");
      assert.equal(request.address, config.address);
      assert.deepEqual(request.args, [expected.entityId]);
      return { owner: researcher, kind: 2, contentHash: expected.contentHash, expiresAt: expected.args[3], withdrawn: false };
    },
  };
}

// Firestore-shaped transactional store, including dotted audit updates. All
// recovery tests use local records and deterministic RPC/storage fixtures.
function store(record) {
  const records = new Map([[`proposals/${record.id}`, record]]);
  const snapshot = path => ({ exists: records.has(path), id: path.split("/").at(-1), data: () => records.get(path) });
  const ref = path => ({ path, id: path.split("/").at(-1), get: async () => snapshot(path) });
  const db = { collection: name => ({ doc: id => ref(`${name}/${id}`) }), runTransaction: async fn => fn({
    get: async reference => snapshot(reference.path),
    set: (reference, value) => records.set(reference.path, value),
    update: (reference, patch) => {
      const value = { ...records.get(reference.path) };
      for (const [key, entry] of Object.entries(patch)) {
        if (key.startsWith("audit.")) value.audit = { ...value.audit, [key.slice(6)]: entry };
        else value[key] = entry;
      }
      records.set(reference.path, value);
    },
  }) };
  return { db, records };
}

describe("independent proposal Opportunity confirmation", () => {
  for (const update of [false, true]) it(`confirms a scheme-2 ${update ? "update" : "commit"} without parent or child escrow`, async () => {
    const record = listing(), expected = prepareStoredProposal(record), client = clientFor(record, { update });
    const audit = await verifyMinedProposal(record, client);
    assert.equal(expected.hashScheme, 2);
    assert.equal(audit.entityId, expected.entityId);
    assert.equal(audit.contentHash, expected.contentHash);
    assert.equal(audit.status, "confirmed");
    assert.equal(audit.blockNumber, 88);
    assert.deepEqual(client.calls.map(call => call.functionName), ["getOpportunity"]);
  });

  it("uses the same verifier during publication and retry", async () => {
    const record = listing();
    assert.deepEqual(await verifyPublication({ scope: "proposals", record, client: clientFor(record) }),
      await verifyMinedProposal(record, clientFor(record)));
  });

  it("retains published listings with legacy funding terms without claiming an escrow", async () => {
    const record = listing({ fundingTerms: { trancheBps: [5000, 5000] } });
    const client = clientFor(record);
    assert.equal((await verifyMinedProposal(record, client)).status, "confirmed");
    assert.deepEqual(client.calls.map(call => call.functionName), ["getOpportunity"]);
  });

  it("derives the entity id from the selected deployment manifest", async () => {
    const config = { ...registry, address: `0x${"7".repeat(40)}`, entityIdScheme: 1 };
    const record = listing(), client = clientFor(record, { config });
    const expected = prepareStoredProposal(record, { registryConfig: config });
    assert.notEqual(expected.entityId, prepareStoredProposal(record).entityId);
    assert.equal((await verifyMinedProposal(record, client, { registryConfig: config })).entityId, expected.entityId);
  });

  it("rejects a changed listing or unrelated registry call", async () => {
    const record = listing(), expected = prepareStoredProposal(record), client = clientFor(record);
    await assert.rejects(verifyMinedProposal({ ...record, title: "Changed after anchoring" }, client), /Mismatch/);
    const unrelated = { ...client, getTransaction: async () => ({ ...await client.getTransaction(),
      input: encodeFunctionData({ abi: registry.abi, functionName: "withdrawOpportunity",
        args: [expected.entityId, expected.contentHash] }) }) };
    await assert.rejects(verifyMinedProposal(record, unrelated), /Mismatch/);
  });

  for (const update of [false, true]) it(`rejects changed ${update ? "update" : "commit"} arguments`, async () => {
    const record = listing(), expected = prepareStoredProposal(record), client = clientFor(record, { update });
    const args = update ? [expected.entityId, expected.contentHash, expected.args[3]] : [...expected.args];
    for (let index = 0; index < args.length; index++) {
      const changed = [...args];
      changed[index] = typeof args[index] === "string" ? `0x${"9".repeat(64)}` : BigInt(args[index]) + 1n;
      const other = { ...client, getTransaction: async () => ({ ...await client.getTransaction(),
        input: encodeFunctionData({ abi: registry.abi,
          functionName: update ? "updateOpportunity" : "commitOpportunity", args: changed }) }) };
      await assert.rejects(verifyMinedProposal(record, other), /Mismatch/);
    }
  });

  it("rejects the wrong wallet, deployment, chain, receipt or reverted transaction", async () => {
    const record = listing(), client = clientFor(record);
    for (const patch of [{ from: `0x${"b".repeat(40)}` }, { to: `0x${"c".repeat(40)}` },
      { chainId: 1 }, { hash: `0x${"9".repeat(64)}` }]) {
      await assert.rejects(verifyMinedProposal(record, { ...client,
        getTransaction: async () => ({ ...await client.getTransaction(), ...patch }) }), /does not belong/);
    }
    await assert.rejects(verifyMinedProposal(record, { ...client, getTransactionReceipt: async () => ({
      ...await client.getTransactionReceipt(), transactionHash: `0x${"9".repeat(64)}` }) }), /does not belong/);
    await assert.rejects(verifyMinedProposal(record, { ...client, getTransactionReceipt: async () => ({
      ...await client.getTransactionReceipt(), status: "reverted" }) }), /reverted/);
  });

  it("requires canonical blocks and the next-block confirmation", async () => {
    const record = listing(), client = clientFor(record);
    await assert.rejects(verifyMinedProposal(record, { ...client,
      getTransaction: async () => ({ ...await client.getTransaction(), blockHash: `0x${"9".repeat(64)}` }) }), /not final/);
    for (const patch of [{ hash: `0x${"9".repeat(64)}` }, { parentHash: `0x${"9".repeat(64)}` }]) {
      await assert.rejects(verifyMinedProposal(record, { ...client,
        getBlock: async () => ({ hash: blockHash, parentHash: blockHash, ...patch }) }), /not final/);
    }
  });

  it("checks the current listing owner, kind, content, expiry and withdrawal state", async () => {
    const record = listing(), client = clientFor(record);
    for (const patch of [{ owner: `0x${"b".repeat(40)}` }, { kind: 1 },
      { contentHash: `0x${"9".repeat(64)}` }, { expiresAt: 1n }, { withdrawn: true }]) {
      await assert.rejects(verifyMinedProposal(record, { ...client,
        readContract: async request => ({ ...await client.readContract(request), ...patch }) }), /Mismatch/);
    }
    const tuple = { ...client, readContract: async request => {
      const value = await client.readContract(request);
      return [value.owner, value.kind, value.contentHash, 0n, 0n, value.expiresAt, value.withdrawn];
    } };
    assert.equal((await verifyMinedProposal(record, tuple)).status, "confirmed");
  });

  it("checks attachment size and digest at the independent proposal storage path", async () => {
    const bytes = Buffer.from("%PDF-1.7\nindependent evidence");
    const attachment = { id: "evidence01", name: "evidence.pdf", size: bytes.length, contentType: "application/pdf",
      sha256: `0x${createHash("sha256").update(bytes).digest("hex")}` };
    const record = listing({ attachments: [attachment] });
    const reader = async path => {
      assert.equal(path, `proposals/${researcher}/${record.id}/evidence01.pdf`);
      return bytes;
    };
    assert.equal((await verifyMinedProposal(record, clientFor(record), { readAttachment: reader })).status, "confirmed");
    await assert.rejects(verifyMinedProposal(record, clientFor(record), {
      readAttachment: async () => Buffer.from("x".repeat(bytes.length)) }), /attachment differs/);
    const wrongSize = listing({ attachments: [{ ...attachment, size: bytes.length + 1 }] });
    await assert.rejects(verifyMinedProposal(wrongSize, clientFor(wrongSize), { readAttachment: reader }), /attachment differs/);
    const badDigest = listing({ attachments: [{ ...attachment, sha256: "invalid" }] });
    await assert.rejects(verifyMinedProposal(badDigest, clientFor(badDigest), { readAttachment: reader }), /digest is missing or invalid/);
    const { sha256, ...legacyAttachment } = attachment;
    const legacy = listing({ attachments: [legacyAttachment] });
    assert.equal((await verifyMinedProposal(legacy, clientFor(legacy), { readAttachment: reader })).status, "confirmed");
    await assert.rejects(verifyMinedProposal(legacy, clientFor(legacy), {
      readAttachment: async () => Buffer.from("short") }), /attachment differs/);
  });
});

describe("independent proposal durable recovery", () => {
  it("confirms the proposal and its queued job without loading a parent", async () => {
    const record = listing(), { db, records } = store(record), client = clientFor(record);
    await enqueueProposalAudit({ db, record, now });
    const audit = await recoverProposalAudit({ db, client, proposalId: record.id, now, Timestamp });
    assert.equal(audit.status, "confirmed");
    assert.equal(records.get(`proposals/${record.id}`).audit.status, "confirmed");
    assert.equal(records.get(`proposalAuditJobs/${record.id}`).status, "confirmed");
    assert.equal(records.get(`proposalAuditJobs/${record.id}`).attemptCount, 1);
    assert.deepEqual(client.calls.map(call => call.functionName), ["getOpportunity"]);
  });

  it("allows manual retry of an existing exhausted independent job", async () => {
    const record = listing(), { db, records } = store(record);
    await enqueueProposalAudit({ db, record, now });
    const path = `proposalAuditJobs/${record.id}`;
    records.set(path, { ...records.get(path), attemptCount: 3, status: "failed" });
    assert.equal((await recoverProposalAudit({ db, client: clientFor(record), proposalId: record.id,
      now, Timestamp, manual: true })).status, "confirmed");
    assert.equal(records.get(path).status, "confirmed");
    assert.equal(records.get(path).attemptCount, 1);
  });

  it("retains a pending job for a transient RPC failure", async () => {
    const record = listing(), { db, records } = store(record);
    await enqueueProposalAudit({ db, record, now });
    const client = { ...clientFor(record), getTransactionReceipt: async () => { throw new Error("HTTP 429"); } };
    await assert.rejects(recoverProposalAudit({ db, client, proposalId: record.id, now, Timestamp }), /checked again/);
    assert.equal(records.get(`proposals/${record.id}`).audit.status, "pending");
    assert.equal(records.get(`proposalAuditJobs/${record.id}`).status, "pending");
  });

  it("does not confirm content changed while verification is in flight", async () => {
    const record = listing(), { db, records } = store(record), base = clientFor(record);
    await enqueueProposalAudit({ db, record, now });
    const client = { ...base, readContract: async request => {
      records.set(`proposals/${record.id}`, { ...record, title: "Changed during verification" });
      return base.readContract(request);
    } };
    await assert.rejects(recoverProposalAudit({ db, client, proposalId: record.id, now, Timestamp }), /record changed/);
    assert.equal(records.get(`proposals/${record.id}`).audit.status, "pending");
    assert.equal(records.get(`proposalAuditJobs/${record.id}`).status, "failed");
  });

  it("does not confirm an attachment digest changed after its bytes were checked", async () => {
    const bytes = Buffer.from("%PDF-1.7\nindependent evidence");
    const attachment = { id: "evidence01", name: "evidence.pdf", size: bytes.length, contentType: "application/pdf",
      sha256: `0x${createHash("sha256").update(bytes).digest("hex")}` };
    const record = listing({ attachments: [attachment] }), { db, records } = store(record), base = clientFor(record);
    await enqueueProposalAudit({ db, record, now });
    const client = { ...base, readContract: async request => {
      records.set(`proposals/${record.id}`, { ...record, attachments: [{ ...attachment, sha256: `0x${"9".repeat(64)}` }] });
      return base.readContract(request);
    } };
    await assert.rejects(recoverProposalAudit({ db, client, proposalId: record.id, now, Timestamp,
      readAttachment: async () => bytes }), /record changed/);
    assert.equal(records.get(`proposals/${record.id}`).audit.status, "pending");
    assert.equal(records.get(`proposalAuditJobs/${record.id}`).status, "failed");
  });
});
