import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { encodeFunctionData } from "viem";
import { Timestamp } from "firebase-admin/firestore";
import { prepareStoredProposal } from "../proposalAuditPayload.js";
import { enqueueProposalAudit, recoverProposalAudit, recoveryError, retryDelay, verifyMinedProposal } from "../proposalAuditRecovery.js";
import registry from "../auditRegistry.contract.json" with { type: "json" };
import frontendRegistry from "../../../frontend/src/config/auditRegistry.contract.json" with { type: "json" };

const hash = `0x${"3".repeat(64)}`;
const blockHash = `0x${"4".repeat(64)}`;
const researcher = `0x${"a".repeat(40)}`;
function fixture(type = "business-problem") {
  return { id: "golden-proposal", problemId: "golden-opportunity", researcherId: researcher,
    postingOwnerId: `0x${"b".repeat(40)}`, opportunityType: type, amount: 1200.25, currency: "USDC",
    title: "Quantum routing", summary: "Benchmark routing", methodology: "Anneal", category: "quantum-annealing",
    proposedProblem: type === "open-funding" ? "Logistics" : "", relevance: type === "open-funding" ? "Fewer delays" : "",
    thesisFit: type === "open-funding" ? "Resilience" : "", status: "submitted",
    audit: { schemaVersion: 1, chainId: 421614, status: "pending", attemptCount: 1, transactionHash: hash, blockNumber: 0, lastError: "" } };
}
function clientFor(record) {
  const expected = prepareStoredProposal(record);
  return {
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 88n, blockHash, transactionHash: hash }),
    getTransaction: async () => ({ hash, to: registry.address, from: researcher, chainId: 421614,
      blockNumber: 88n, blockHash,
      input: encodeFunctionData({ abi: registry.abi, functionName: "commitProposal", args: expected.args }) }),
    getBlock: async ({ blockNumber }) => blockNumber === 88n
      ? { hash: blockHash }
      : { hash: `0x${"5".repeat(64)}`, parentHash: blockHash },
    readContract: async () => ({ researcher, opportunityId: expected.opportunityId, opportunityRevisionIndex: 0,
      proposalHash: expected.proposalHash, solutionHash: expected.solutionHash }),
  };
}

// Minimal transactional store to exercise durable recovery without RPC or wallet.
function store(record) {
  const records = new Map([[`proposals/${record.id}`, record]]);
  const ref = (path) => ({ path, id: path.split("/").at(-1), get: async () => snapshot(path) });
  const snapshot = (path) => ({ exists: records.has(path), id: path.split("/").at(-1), data: () => records.get(path) });
  const db = { collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }), runTransaction: async (fn) => fn({
    get: async (reference) => snapshot(reference.path),
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

describe("QCDAO-75 proposal golden vectors", () => {
  it("keeps frontend and server deployment manifests in sync", () => assert.deepEqual(registry, frontendRegistry));
  for (const [type, proposalHash, anchorHash] of [
    ["business-problem", "0xc11114c067b8fdd034585e139b7f94f0a32fc679134e460812a51474cb4fe51b", "0x6d82c2af4687964318a5605e0656f5d0af8d28d3fac979b1f0cc141423526094"],
    ["open-funding", "0x8e517189ffb6b93a87e62c00b2e7da3d23197293a41e7579da17e95671533f53", "0x6dfbff480faeafce0ee6b4649e980948d0ad3a83e599f2259cffe8b0a29dda74"],
  ]) it(`reproduces ${type} v1 hashes`, () => {
    const record = fixture(type), prepared = prepareStoredProposal(record);
    assert.equal(prepared.proposalHash, proposalHash);
    assert.equal(prepared.solutionHash, "0x391f4fc0d062179dd35eefb29335de8980febcb17a0e22c61f6c07d0f4da366f");
    assert.equal(prepared.anchorHash, anchorHash);
    assert.equal(prepareStoredProposal({ ...record, status: "withdrawn", updatedAt: Timestamp.now() }).proposalHash, proposalHash);
    assert.notEqual(prepareStoredProposal({ ...record, amount: 1200.26 }).proposalHash, proposalHash);
  });
  it("binds the solution hash to attachment bytes", () => {
    const attachment = { id: "attachment01", name: "evidence.pdf", size: 200, contentType: "application/pdf",
      sha256: `0x${"1".repeat(64)}` };
    const first = prepareStoredProposal({ ...fixture(), attachments: [attachment] });
    const second = prepareStoredProposal({ ...fixture(), attachments: [{ ...attachment, sha256: `0x${"2".repeat(64)}` }] });
    assert.notEqual(first.solutionHash, second.solutionHash);
  });
});

describe("QCDAO-76/78 trusted proposal confirmation", () => {
  for (const type of ["business-problem", "open-funding"]) it(`confirms a matching ${type} transaction`, async () => {
    const record = fixture(type);
    const result = await verifyMinedProposal(record, clientFor(record));
    assert.equal(result.status, "confirmed"); assert.equal(result.blockNumber, 88);
  });
  it("detects changed content and attachments instead of trusting receipt hashes", async () => {
    const record = fixture();
    for (const patch of [{ title: "Tamper" }, { attachments: [{ id: "pdf", name: "changed.pdf" }] }]) {
      await assert.rejects(verifyMinedProposal({ ...record, ...patch }, clientFor(record)), /Mismatch/);
    }
  });
  it("confirms only when stored attachment bytes match their SHA-256 digest", async () => {
    const bytes = Buffer.from("%PDF-1.7\ntrusted proposal evidence");
    const digest = `0x${createHash("sha256").update(bytes).digest("hex")}`;
    const record = { ...fixture(), attachments: [{ id: "attachment01", name: "evidence.pdf", size: bytes.length,
      contentType: "application/pdf", sha256: digest }] };
    let requestedPath = "";
    const result = await verifyMinedProposal(record, clientFor(record), { readAttachment: async (path) => {
      requestedPath = path;
      return bytes;
    } });
    assert.equal(result.status, "confirmed");
    assert.equal(requestedPath, `proposals/${researcher}/${record.id}/attachment01.pdf`);
    await assert.rejects(
      verifyMinedProposal(record, clientFor(record), { readAttachment: async () => Buffer.from("different bytes") }),
      /stored proposal attachment differs/,
    );
  });
  it("rejects the wrong actor, contract, chain and reverted transaction", async () => {
    const record = fixture();
    for (const patch of [{ from: `0x${"b".repeat(40)}` }, { to: `0x${"c".repeat(40)}` }, { chainId: 1 }]) {
      const client = clientFor(record), original = client.getTransaction;
      client.getTransaction = async () => ({ ...await original(), ...patch });
      await assert.rejects(verifyMinedProposal(record, client), /does not belong/);
    }
    const client = clientFor(record);
    client.getTransactionReceipt = async () => ({ status: "reverted" });
    await assert.rejects(verifyMinedProposal(record, client), /reverted/);
  });
  it("detects a later change in the registry itself", async () => {
    const record = fixture(), client = clientFor(record), read = client.readContract;
    client.readContract = async () => ({ ...await read(), solutionHash: hash });
    await assert.rejects(verifyMinedProposal(record, client), /Mismatch/);
  });
  it("requires one canonical block view and two confirmations", async () => {
    const record = fixture();
    for (const mutate of [
      (client) => { client.getTransaction = async () => ({ ...await clientFor(record).getTransaction(), blockHash: hash }); },
      (client) => { client.getBlock = async ({ blockNumber }) => blockNumber === 88n
        ? { hash }
        : { hash: `0x${"5".repeat(64)}`, parentHash: blockHash }; },
      (client) => { client.getBlock = async ({ blockNumber }) => blockNumber === 88n
        ? { hash: blockHash }
        : { hash: `0x${"5".repeat(64)}`, parentHash: hash }; },
    ]) {
      const client = clientFor(record);
      mutate(client);
      await assert.rejects(verifyMinedProposal(record, client), /not final/);
    }
    assert.equal(recoveryError(new Error("The transaction is not final yet.")).transient, true);
  });
});

describe("QCDAO-79 durable recovery", () => {
  it("persists confirmation and makes duplicate enqueue delivery idempotent", async () => {
    const record = fixture(), { db, records } = store(record), now = Timestamp.fromMillis(1000);
    await enqueueProposalAudit({ db, record, now });
    await recoverProposalAudit({ db, client: clientFor(record), proposalId: record.id, now, Timestamp });
    await enqueueProposalAudit({ db, record, now });
    assert.equal(records.get(`proposals/${record.id}`).audit.status, "confirmed");
    assert.equal(records.get(`proposalAuditJobs/${record.id}`).status, "confirmed");
  });
  it("retries transient reads with backoff, caps attempts, then permits admin recovery", async () => {
    const record = fixture(), { db, records } = store(record);
    let now = Timestamp.fromMillis(1000);
    await enqueueProposalAudit({ db, record, now });
    const unavailable = { getTransactionReceipt: async () => { throw new Error("HTTP 503"); }, getTransaction: async () => { throw new Error("HTTP 503"); } };
    for (let attempt = 1; attempt <= 3; attempt++) {
      await assert.rejects(recoverProposalAudit({ db, client: unavailable, proposalId: record.id, now, Timestamp }), /Proposal saved/);
      const job = records.get(`proposalAuditJobs/${record.id}`);
      assert.equal(job.attemptCount, attempt);
      assert.equal(job.nextAttemptAt.toMillis() - now.toMillis(), retryDelay(attempt));
      if (attempt < 3) assert.equal(await recoverProposalAudit({ db, client: unavailable, proposalId: record.id, now, Timestamp }), null);
      now = job.nextAttemptAt;
    }
    assert.equal(records.get(`proposalAuditJobs/${record.id}`).status, "failed");
    assert.equal(await recoverProposalAudit({ db, client: unavailable, proposalId: record.id, now, Timestamp }), null);
    await recoverProposalAudit({ db, client: clientFor(record), proposalId: record.id, now, Timestamp, manual: true });
    assert.equal(records.get(`proposals/${record.id}`).audit.status, "confirmed");
  });
  it("does not submit transactions or fabricate confirmation for wallet-less jobs", async () => {
    const record = fixture(); record.audit.transactionHash = "";
    const { db, records } = store(record), now = Timestamp.now();
    await enqueueProposalAudit({ db, record, now });
    assert.equal(records.get(`proposalAuditJobs/${record.id}`).status, "waiting-wallet");
    await assert.rejects(recoverProposalAudit({ db, client: {}, proposalId: record.id, now, Timestamp, manual: true }), /researcher must submit/);
  });
  it("leases a job so simultaneous recovery requests do not race", async () => {
    const record = fixture(), { db, records } = store(record), now = Timestamp.now();
    await enqueueProposalAudit({ db, record, now });
    const client = clientFor(record), original = client.getTransactionReceipt;
    let release, started;
    const reading = new Promise((resolve) => { started = resolve; });
    client.getTransactionReceipt = async () => { started(); await new Promise((resolve) => { release = resolve; }); return original(); };
    const first = recoverProposalAudit({ db, client, proposalId: record.id, now, Timestamp });
    await reading;
    await assert.rejects(recoverProposalAudit({ db, client, proposalId: record.id, now, Timestamp, manual: true }), /already being checked/);
    release(); await first;
    assert.equal(records.get(`proposalAuditJobs/${record.id}`).attemptCount, 1);
    assert.equal(records.get(`proposals/${record.id}`).audit.status, "confirmed");
  });
  it("refuses stale content after the chain check", async () => {
    const record = fixture(), { db, records } = store(record), now = Timestamp.now();
    await enqueueProposalAudit({ db, record, now });
    const client = clientFor(record), read = client.readContract;
    client.readContract = async () => { records.set(`proposals/${record.id}`, { ...record, title: "Changed during check" }); return read(); };
    await assert.rejects(recoverProposalAudit({ db, client, proposalId: record.id, now, Timestamp }), /record changed/);
    assert.notEqual(records.get(`proposals/${record.id}`).audit.status, "confirmed");
  });
  it("classifies a dropped transaction as pending and a revert as terminal", () => {
    assert.equal(recoveryError(new Error("TransactionReceiptNotFoundError")).transient, true);
    assert.equal(recoveryError(new Error("Transaction reverted")).transient, false);
  });
  it("retries temporary Storage and RPC transport failures", () => {
    for (const message of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "status code 502", "HTTP 504"]) {
      assert.equal(recoveryError(new Error(message)).transient, true, message);
    }
  });
});
