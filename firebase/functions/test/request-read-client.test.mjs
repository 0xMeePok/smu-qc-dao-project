import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequestReadClient } from "../requestReadClient.js";
import { getFunderDashboard } from "../funderDashboard.js";
import { prepareStoredProposal } from "../proposalAuditPayload.js";
import { openFundingFixture, owner, researcher } from "./fixtures/openFundingFixture.js";

const abi = [{ type: "function", name: "value", inputs: [], outputs: [{ type: "uint256" }] }];
const request = (overrides = {}) => ({ address: "0x1234", abi, functionName: "value", blockNumber: 100n, ...overrides });

describe("request-scoped pinned reads", () => {
  it("shares concurrent identical reads and normalizes implicit chain and empty arguments", async () => {
    let calls = 0;
    const client = createRequestReadClient({ readContract: async () => ({ calls: ++calls }) }, { chainId: 421614 });
    const results = await Promise.all([
      client.readContract(request()), client.readContract(request({ args: [], chainId: 421614 })),
      client.readContract({ ...request(), functionName: "value", address: "0x1234" }),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(results, [{ calls: 1 }, { calls: 1 }, { calls: 1 }]);
  });

  it("keeps contracts, blocks, users, argument types, ABIs and state overrides separate", async () => {
    let calls = 0;
    const client = createRequestReadClient({ readContract: async () => ++calls });
    const distinct = [request(), request({ address: "0x5678" }), request({ blockNumber: 101n }),
      request({ account: owner }), request({ account: researcher }), request({ args: [1n] }), request({ args: ["1"] }),
      request({ abi: [...abi] }), request({ stateOverride: [{ address: owner, balance: 1n }] }), request({ chainId: 1 })];
    assert.deepEqual(await Promise.all(distinct.map((row) => client.readContract(row))), Array.from({ length: distinct.length }, (_, i) => i + 1));
    assert.equal(calls, distinct.length);
  });

  it("shares pinned block reads but preserves latest reads, fresh heads, receipts and transactions", async () => {
    const counts = {}, client = createRequestReadClient(Object.fromEntries([
      "readContract", "getBlock", "getBlockNumber", "getTransactionReceipt", "sendRawTransaction",
    ].map((name) => [name, async () => counts[name] = (counts[name] || 0) + 1])));
    await Promise.all([client.getBlock({ blockNumber: 100n }), client.getBlock({ blockNumber: 100n })]);
    assert.equal(counts.getBlock, 1);
    await client.getBlock({ blockNumber: 100n, includeTransactions: true });
    for (let i = 0; i < 2; i++) {
      await client.readContract({ ...request(), blockNumber: undefined });
      await client.getBlock({ blockTag: "latest" });
      await client.getBlockNumber({ cacheTime: 0 });
      await client.getTransactionReceipt({ hash: "0x1234" });
      await client.sendRawTransaction({ serializedTransaction: "0x1234" });
    }
    assert.deepEqual(counts, { getBlock: 4, readContract: 2, getBlockNumber: 2, getTransactionReceipt: 2, sendRawTransaction: 2 });
  });

  it("evicts failed reads and preserves the original error for every waiter", async () => {
    const error = new Error("RPC unavailable");
    let calls = 0;
    const client = createRequestReadClient({ readContract: async () => { if (++calls === 1) throw error; return 7n; } });
    const results = await Promise.allSettled([client.readContract(request()), client.readContract(request())]);
    assert.equal(calls, 1);
    assert.ok(results.every((result) => result.status === "rejected" && result.reason === error));
    assert.equal(await client.readContract(request()), 7n);
    assert.equal(calls, 2);
  });

  it("allocates independent caches for every request, including chain identity", async () => {
    let balance = 7n, chainCalls = 0, readCalls = 0;
    const original = { getChainId: async () => (++chainCalls, 421614), readContract: async () => (++readCalls, balance) };
    const first = createRequestReadClient(original);
    assert.deepEqual(await Promise.all([first.getChainId(), first.getChainId()]), [421614, 421614]);
    assert.equal(await first.readContract(request()), 7n);
    balance = 9n;
    const next = createRequestReadClient(original);
    assert.equal(await next.getChainId(), 421614);
    assert.equal(await next.readContract(request()), 9n);
    assert.equal(chainCalls, 2); assert.equal(readCalls, 2);
  });

  it("passes through unfamiliar read options and keeps original client method binding", async () => {
    const original = { calls: 0, readContract() { return ++this.calls; } };
    const client = createRequestReadClient(original), account = { address: owner, sign: () => "signature" };
    assert.equal(client.readContract(request({ account })), 1);
    assert.equal(client.readContract(request({ account })), 2);
    assert.equal(original.calls, 2);
  });
});

function businessFixture() {
  const f = openFundingFixture();
  f.posting.opportunityType = "business-problem";
  for (let i = 0; i < f.proposals.length; i++) {
    const row = f.proposals[i];
    row.opportunityType = "business-problem";
    f.expected[i] = prepareStoredProposal(row, { registryConfig: f.config });
    f.state.escrowDeposits[i] = 50_000_000_000n;
    f.db.records.set(`escrowFundingEvents/deposit-${i}`, { actor: owner, registryAddress: f.config.address,
      eventType: "Deposit", verified: true, chainId: f.config.chainId, proposalId: row.id });
  }
  const read = f.client.readContract;
  f.client.readContract = async (row) => {
    const i = f.addresses.indexOf(row.address);
    if (i >= 0 && row.functionName === "postingId") { f.calls.push(row); return f.expected[i].opportunityId; }
    return read(row);
  };
  return f;
}

function instrument(client) {
  const counts = {};
  for (const name of ["getChainId", "getBlockNumber", "getBlock", "getTransactionReceipt", "readContract"]) {
    const fn = client[name];
    client[name] = async (...args) => { counts[name] = (counts[name] || 0) + 1; return fn(...args); };
  }
  return counts;
}

describe("funder dashboard RPC fanout", () => {
  it("avoids duplicate decision/commitment verification while keeping exact accounting", async () => {
    const f = businessFixture(), counts = instrument(f.client), before = JSON.stringify([...f.db.records]);
    const result = await getFunderDashboard(f);
    // Before request sharing this fixture issued 158 contract reads / 169 RPCs.
    assert.equal(counts.readContract, 70);
    assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), 75);
    assert.equal(result.decisions.length, 2); assert.equal(result.commitments.length, 2);
    assert.equal(result.totals[0].committed, "100000000000");
    assert.equal(result.totals[0].locked, "100000000000");
    assert.equal(result.totalsPartial, false);
    assert.equal(JSON.stringify([...f.db.records]), before);
    assert.equal(f.simulations.length, 0);
    assert.ok(f.calls.every((row) => row.blockNumber === 100n));
    assert.equal(f.calls.filter((row) => row.functionName === "milestoneAt").length, 4);
  });

  it("shares grant factory and milestone reads while retaining both accepted grants", async () => {
    const f = openFundingFixture(); f.select(0, 2); f.select(1, 2);
    const counts = instrument(f.client), result = await getFunderDashboard(f);
    // Before request sharing this fixture issued 97 contract reads / 106 RPCs.
    assert.equal(counts.readContract, 85);
    assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), 90);
    assert.equal(result.decisions.length, 2); assert.equal(result.commitments.length, 2);
    assert.equal(result.totals[0].committed, "100000000000");
    assert.equal(result.totalsPartial, false);
    assert.equal(counts.getBlock, 2); // The safe block and the publication block.
  });

  it("refreshes the head and wallet commitments on the next dashboard request", async () => {
    const f = businessFixture(), counts = instrument(f.client);
    const first = await getFunderDashboard(f);
    f.state.released[0] = 10_000_000_000n;
    f.state.refunded[0] = 5_000_000_000n;
    f.client.getBlockNumber = async (options) => { assert.equal(options.cacheTime, 0); return 103n; };
    const next = await getFunderDashboard(f);
    assert.equal(first.blockNumber, 100); assert.equal(next.blockNumber, 102);
    assert.equal(first.totals[0].locked, "100000000000");
    assert.equal(next.totals[0].locked, "85000000000");
    assert.equal(next.totals[0].released, "10000000000");
    assert.equal(next.totals[0].refunded, "5000000000");
    assert.equal(counts.getChainId, 2);
    assert.ok(f.calls.some((row) => row.blockNumber === 102n));
    const other = await getFunderDashboard({ ...f, uid: researcher });
    assert.deepEqual(other.commitments, []); assert.deepEqual(other.totals, []);
  });

  it("reports unavailable commitments instead of retaining a previous request's balances", async () => {
    const f = businessFixture();
    assert.equal((await getFunderDashboard(f)).totals[0].committed, "100000000000");
    f.client.readContract = async () => { throw new Error("RPC unavailable"); };
    const result = await getFunderDashboard(f);
    assert.deepEqual(result.commitments, []); assert.deepEqual(result.totals, []);
    assert.equal(result.unavailableCommitments, 2); assert.equal(result.unavailableDecisions, 2);
    assert.equal(result.totalsPartial, true);
  });
});
