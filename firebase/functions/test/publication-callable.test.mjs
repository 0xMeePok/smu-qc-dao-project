import assert from "node:assert/strict";
import { it } from "node:test";
import { getFirestore } from "firebase-admin/firestore";
import { numberToHex } from "viem";
import { attestPublication } from "../index.js";
import registry from "../auditRegistry.contract.json" with { type: "json" };
import { escrowClient, escrowConfig, escrowRecord } from "./fixtures/escrowAuditFixture.js";
import { memoryDb } from "./memoryDb.mjs";
import { answerEthCall } from "./answerEthCall.mjs";

function mockRpc(t, client) {
  return t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { id, method, params } = JSON.parse(options.body);
    let result;
    if (method === "eth_chainId") {
      result = numberToHex(escrowConfig.chainId);
    } else if (method === "eth_getTransactionReceipt") {
      const receipt = await client.getTransactionReceipt();
      result = { ...receipt, status: "0x1", blockNumber: numberToHex(receipt.blockNumber),
        logs: (receipt.logs ?? []).map((log, index) => ({ ...log,
          blockNumber: numberToHex(log.blockNumber ?? receipt.blockNumber),
          blockHash: log.blockHash ?? receipt.blockHash,
          transactionHash: log.transactionHash ?? receipt.transactionHash,
          logIndex: numberToHex(log.logIndex ?? index), transactionIndex: numberToHex(log.transactionIndex ?? 0), removed: false })) };
    } else if (method === "eth_getTransactionByHash") {
      const transaction = await client.getTransaction();
      result = { ...transaction, blockNumber: numberToHex(transaction.blockNumber), chainId: numberToHex(transaction.chainId),
        type: "0x2", gas: "0x10000", nonce: "0x0", value: "0x0", transactionIndex: "0x0" };
    } else if (method === "eth_getBlockByNumber") {
      result = { ...await client.getBlock({ blockNumber: BigInt(params[0]) }), number: params[0], transactions: [] };
    } else if (method === "eth_call") {
      const abiFor = (address) => {
        const target = String(address).toLowerCase();
        if (target === escrowConfig.address.toLowerCase()) return escrowConfig.abi;
        if (target === escrowConfig.escrow.factoryAddress.toLowerCase()) return escrowConfig.escrow.factoryAbi;
        return escrowConfig.escrow.escrowAbi;
      };
      result = await answerEthCall({ to: params[0].to, data: params[0].data, client, abiFor });
    } else {
      throw new Error(`Unexpected RPC method: ${method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "Content-Type": "application/json" } });
  });
}

it("attestPublication creates exact fixed-split proofs and refuses custom terms on creates, promotions, and corrections", async (t) => {
  const savedRegistry = { ...registry };
  Object.assign(registry, escrowConfig);
  try {
    for (const status of [undefined, "draft", "submitted"]) {
      const record = escrowRecord();
      const uid = record.researcherId;
      const initial = { [`users/${uid}`]: { suspended: false } };
      if (status) initial[`proposals/${record.id}`] = { ...record, status };
      const db = memoryDb(initial);
      t.mock.method(getFirestore(), "collection", db.collection.bind(db));
      t.mock.method(getFirestore(), "runTransaction", db.runTransaction.bind(db));
      const fetchMock = mockRpc(t, escrowClient(record));
      const request = { auth: { uid, token: { auth_time: 1 } },
        data: { scope: "proposals", recordId: record.id, record } };

      assert.deepEqual(await attestPublication.run(request), { verified: true });
      const proofPath = `publicationProofs/proposals_${record.id}`;
      const proof = db.records.get(proofPath);
      assert.deepEqual(proof.record.fundingTerms.trancheBps, [5000, 5000]);
      assert.equal(proof.transactionHash, record.audit.transactionHash);
      assert.ok(fetchMock.mock.callCount() > 0, "the real mined-transaction verification ran");

      db.records.delete(proofPath);
      const custom = { ...record, fundingTerms: { ...record.fundingTerms,
        trancheBps: [10000], reviewWindows: [604800], milestoneHashes: record.fundingTerms.milestoneHashes.slice(0, 1) } };
      if (status) db.records.set(`proposals/${record.id}`, { ...custom, status });
      await assert.rejects(attestPublication.run({ ...request, data: { ...request.data, record: custom } }),
        { code: "failed-precondition" });
      assert.equal(db.records.has(proofPath), false, "custom terms must not receive a publication proof");
      t.mock.restoreAll();
    }
  } finally {
    Object.assign(registry, savedRegistry);
    t.mock.restoreAll();
  }
});
