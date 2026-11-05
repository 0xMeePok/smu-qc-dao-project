import assert from "node:assert/strict";
import { test } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { keccak256 } from "viem";
import { memoryDb } from "./memoryDb.mjs";
import { escrowConfig, escrowRecord, escrowAddress, owner } from "./fixtures/escrowAuditFixture.js";
import { submitPlatformAction, deploymentKey, PLATFORM_OUTBOX, FUNDING_JOBS } from "../escrowFunding.js";

const signer = `0x${"9".repeat(40)}`, bytes = "0x1234";
const now = Timestamp.fromMillis(1900000000000);
function fixture(functionName, mutateDuringPrepare) {
  const record = escrowRecord(), parent = { ownerId: owner, status: "submitted" };
  const proposalPath = `proposals/${record.id}`, parentPath = `problems/${record.problemId}`;
  const db = memoryDb({ [proposalPath]: record, [parentPath]: parent });
  const broadcasts = [], signed = [];
  const client = { getChainId: async () => 421614, readContract: async () => signer,
    simulateContract: async () => ({}), getTransactionCount: async () => 7,
    sendRawTransaction: async value => broadcasts.push(value),
    getTransactionReceipt: async () => { throw new Error("Not mined"); }, getBlockNumber: async () => 101n };
  const getWallet = async () => ({ account: { address: signer }, chain: { id: 421614 },
    prepareTransactionRequest: async value => { mutateDuringPrepare?.({ db, proposalPath, parentPath }); return value; },
    signTransaction: async () => { signed.push(bytes); return bytes; } });
  const args = escrowConfig.escrow.escrowAbi.find(item => item.type === "function" && item.name === functionName)
    .inputs.map(input => input.type === "bytes32" ? `0x${"5".repeat(64)}` : input.type === "address" ? owner : 0n);
  const action = { address: escrowAddress, abi: escrowConfig.escrow.escrowAbi, functionName, args,
    key: `${functionName}:test`, proposalId: record.id };
  return { db, client, config: escrowConfig, getWallet, action, now, record, parentPath, proposalPath, broadcasts, signed };
}
const blockedStates = [
  { moderationStatus: "hidden" }, { moderationStatus: "removed" }, { moderated: true },
  { status: "draft" }, { status: "withdrawn" }, { status: "cancelled" },
  { status: "moderated_hidden" }, { status: "moderated_removed" },
];
for (const functionName of ["lockSelection", "release", "releaseMilestone"]) {
  for (const target of ["proposalPath", "parentPath"]) {
    for (const state of blockedStates) {
      const label = `${functionName} ${target} ${JSON.stringify(state)}`;
      test(`${label}: refuses before claiming`, async () => {
        const f = fixture(functionName);
        f.db.records.set(f[target], { ...f.db.records.get(f[target]), ...state });
        const result = await submitPlatformAction(f);
        assert.equal(result.status, "blocked"); assert.equal(f.signed.length, 0); assert.equal(f.broadcasts.length, 0);
      });
      test(`${label}: refuses changes during wallet preparation`, async () => {
        const f = fixture(functionName, ({ db, ...paths }) => db.records.set(paths[target], { ...db.records.get(paths[target]), ...state }));
        await assert.rejects(submitPlatformAction(f), error => error.code === "aborted" || error.code === "failed-precondition");
        assert.equal(f.broadcasts.length, 0);
        assert.equal(f.db.records.get(`${PLATFORM_OUTBOX}/${deploymentKey(escrowConfig)}`)?.transactionHash, undefined);
      });
    }
  }
  test(`${functionName}: scheduled expiry preserves selected escrow settlement`, async () => {
    const f = fixture(functionName);
    f.db.records.set(f.parentPath, { ...f.db.records.get(f.parentPath), status: "expired", expirySource: "scheduled" });
    assert.equal((await submitPlatformAction(f)).status, "pending"); assert.equal(f.broadcasts.length, 1);
  });
  test(`${functionName}: resumes exact durable bytes after removal`, async () => {
    const f = fixture(functionName), transactionHash = keccak256(bytes);
    f.db.records.set(f.parentPath, { ...f.db.records.get(f.parentPath), moderationStatus: "removed" });
    f.db.records.set(`${PLATFORM_OUTBOX}/${deploymentKey(escrowConfig)}`, {
      transactionHash, serializedTransaction: bytes, actionKey: f.action.key, signerAddress: signer, nonce: 7,
    });
    assert.equal((await submitPlatformAction(f)).transactionHash, transactionHash);
    assert.deepEqual(f.broadcasts, [{ serializedTransaction: bytes }]); assert.equal(f.signed.length, 0);
  });
  for (const stage of ["before", "during"]) {
    for (const intent of ["proposal removal", "posting removal", "void job", "cancellation job", "cancellation record", "manual expiry"]) {
      test(`${functionName}: blocks ${intent} ${stage} preparation`, async () => {
        const apply = ({ db, proposalPath, parentPath }) => {
          if (intent.endsWith("removal")) db.records.set("escrowModerationVoidEnumerations/remove-1", {
            contentType: intent.startsWith("proposal") ? "proposal" : "problem",
            contentId: intent.startsWith("proposal") ? proposalPath.split("/")[1] : parentPath.split("/")[1], status: "pending",
          });
          if (intent === "void job") db.records.set("escrowModerationVoidJobs/remove-1", { proposalId: proposalPath.split("/")[1], status: "pending" });
          if (intent === "cancellation job") db.records.set(`${FUNDING_JOBS}/${deploymentKey(escrowConfig)}_${proposalPath.split("/")[1]}`,
            { adminCancellationId: "cancel-1", adminCancellationStatus: "pending" });
          if (intent === "cancellation record") db.records.set(proposalPath, { ...db.records.get(proposalPath), escrowAdminCancellation: { status: "queued" } });
          if (intent === "manual expiry") db.records.set(parentPath, { ...db.records.get(parentPath), status: "expired", expirySource: "manual" });
        };
        const f = fixture(functionName, stage === "during" ? apply : null);
        if (stage === "before") { apply(f); assert.equal((await submitPlatformAction(f)).status, "blocked"); assert.equal(f.signed.length, 0); }
        else await assert.rejects(submitPlatformAction(f), error => error.code === "aborted");
        assert.equal(f.broadcasts.length, 0);
        assert.equal(f.db.records.get(`${PLATFORM_OUTBOX}/${deploymentKey(escrowConfig)}`)?.transactionHash, undefined);
      });
    }
  }
}

for (const functionName of ["refundInvalidated", "expire", "voidEscrow"]) {
  test(`${functionName}: removal leaves refund and void actions usable`, async () => {
    const f = fixture(functionName);
    f.db.records.set(f.parentPath, { ...f.db.records.get(f.parentPath), moderationStatus: "removed" });
    assert.equal((await submitPlatformAction(f)).status, "pending"); assert.equal(f.broadcasts.length, 1);
  });
}
