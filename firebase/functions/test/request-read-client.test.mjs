import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequestReadClient } from "../requestReadClient.js";
import { seedDashboardSnapshots } from "./fixtures/dashboardSnapshots.js";
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

function completePositionReads(f) {
  const read = f.client.readContract;
  f.client.readContract = async request => {
    const result = await read(request);
    return request.functionName === "depositorSummary" ? { ...result, claimable: 0n } : result;
  };
}

describe("funder dashboard saved projections", () => {
  it("does not call any RPC and preserves exact commitments and authorization", async () => {
    const f = businessFixture(); await seedDashboardSnapshots(f);
    const counts = instrument(f.client), before = JSON.stringify([...f.db.records]);
    const result = await getFunderDashboard(f);
    assert.deepEqual(counts, {});
    assert.equal(result.decisions.length, 2); assert.equal(result.commitments.length, 2);
    assert.equal(result.totals[0].committed, "100000000000");
    assert.equal(result.totals[0].locked, "100000000000");
    assert.equal(result.totalsPartial, false);
    assert.equal(JSON.stringify([...f.db.records]), before);
    const other = await getFunderDashboard({ ...f, uid: researcher });
    assert.deepEqual(other.commitments, []); assert.deepEqual(other.totals, []);
    f.db.records.get(`users/${owner}`).suspended = true;
    await assert.rejects(getFunderDashboard(f), { code: "permission-denied" });
  });

  it("reads accepted grants without an RPC even when the provider is offline", async () => {
    const f = openFundingFixture(); f.select(0, 2); f.select(1, 2);
    await seedDashboardSnapshots(f);
    f.client = new Proxy({}, { get() { assert.fail("Dashboard must never access RPC"); } });
    const result = await getFunderDashboard(f);
    assert.equal(result.decisions.length, 2); assert.equal(result.commitments.length, 2);
    assert.equal(result.totals[0].committed, "100000000000");
    assert.equal(result.totalsPartial, false);
  });

  it("refreshes saved balances after transaction sync without mixing blocks", async () => {
    const f = businessFixture(); await seedDashboardSnapshots(f);
    const first = await getFunderDashboard(f);
    f.state.released[0] = 10_000_000_000n;
    f.state.refunded[0] = 5_000_000_000n;
    f.client.getBlockNumber = async () => 103n;
    // Chain changes alone do not cause dashboard RPCs or guesses.
    assert.deepEqual((await getFunderDashboard(f)).totals, first.totals);
    await seedDashboardSnapshots(f);
    const counts = instrument(f.client), next = await getFunderDashboard(f);
    assert.equal(first.commitments[0].blockNumber, 100); assert.equal(next.commitments[0].blockNumber, 102);
    assert.equal(next.totals[0].locked, "85000000000");
    assert.equal(next.totals[0].released, "10000000000");
    assert.equal(next.totals[0].refunded, "5000000000");
    assert.deepEqual(counts, {});
  });

  it("reports missing or corrupt snapshots as partial rather than inventing zero totals", async () => {
    const f = businessFixture(); await seedDashboardSnapshots(f);
    for (const [path, row] of f.db.records) if (path.startsWith("escrowFundingPositions/")) {
      if (row.proposalId === f.proposals[0].id) f.db.records.delete(path);
      else row.released = "50000000001";
    }
    const result = await getFunderDashboard(f);
    assert.deepEqual(result.commitments, []); assert.deepEqual(result.totals, []);
    assert.equal(result.unavailableCommitments, 2); assert.equal(result.totalsPartial, true);
  });

  it("rejects foreign deployment positions if verified fallback is unavailable", async () => {
    const f = businessFixture(); await seedDashboardSnapshots(f);
    for (const [path, row] of f.db.records) if (path.startsWith("escrowFundingPositions/")) {
      if (row.proposalId === f.proposals[0].id) row.chainId = 1;
      else row.registryAddress = researcher;
    }
    f.client.getChainId = async () => { throw new Error("Offline"); };
    const result = await getFunderDashboard(f);
    assert.deepEqual(result.totals, []); assert.equal(result.unavailableCommitments, 2);
  });
  it("verifies missing snapshots once, persists them and makes the next dashboard RPC-free", async () => {
    const f = businessFixture(); completePositionReads(f);
    const first = await getFunderDashboard(f);
    assert.equal(first.commitments.length, 2);
    assert.equal(first.totals[0].committed, "100000000000");
    assert.equal(first.totalsPartial, false);
    assert.equal([...f.db.records.keys()].filter(key => key.startsWith("escrowFundingPositions/")).length, 2);
    f.client = new Proxy({}, { get() { assert.fail("Saved dashboard must not access RPC"); } });
    assert.deepEqual((await getFunderDashboard(f)).totals, first.totals);
  });

  it("fills only the missing wallet position and leaves saved positions untouched", async () => {
    const f = businessFixture(); completePositionReads(f); await seedDashboardSnapshots(f);
    for (const [path, row] of f.db.records) if (path.startsWith("escrowFundingPositions/") && row.proposalId === f.proposals[1].id) f.db.records.delete(path);
    f.calls.length = 0;
    const result = await getFunderDashboard(f);
    assert.equal(result.commitments.length, 2); assert.equal(result.totalsPartial, false);
    const reads = f.calls.filter(row => row.functionName === "depositorSummary");
    assert.equal(reads.length, 1); assert.equal(reads[0].address, f.addresses[1]);
  });

  it("fills grant pools, offers and accepted positions then reuses them", async () => {
    const f = openFundingFixture(); completePositionReads(f); f.select(0, 2); f.select(1);
    const first = await getFunderDashboard(f);
    assert.equal(first.opportunities[0].poolUnavailable, false);
    assert.deepEqual(first.decisions.map(row => row.selection.status), ["accepted", "pending"]);
    assert.equal(first.commitments.length, 1); assert.equal(first.totalsPartial, false);
    f.client = new Proxy({}, { get() { assert.fail("Saved grant dashboard must not access RPC"); } });
    const second = await getFunderDashboard(f);
    assert.deepEqual(second.totals, first.totals); assert.deepEqual(second.decisions, first.decisions);
  });

  it("refreshes a wallet snapshot that predates a newly saved payout summary", async () => {
    const f = businessFixture(); completePositionReads(f); await seedDashboardSnapshots(f);
    for (const [path, row] of f.db.records) if (path.startsWith("escrowFundingSummaries/") && row.proposalId === f.proposals[0].id) { row.blockNumber = 102; row.totalReleased = "10000000000"; }
    f.state.released[0] = 10_000_000_000n;
    f.client.getBlockNumber = async () => 103n; f.calls.length = 0;
    const result = await getFunderDashboard(f);
    assert.equal(result.totals[0].released, "10000000000");
    assert.equal(f.calls.filter(row => row.functionName === "depositorSummary").length, 1);
  });

  it("does not let saved zero-balance prospects crowd funded commitments out", async () => {
    const f = businessFixture(); await seedDashboardSnapshots(f);
    const example = [...f.db.records.entries()].find(([path]) => path.startsWith("escrowFundingPositions/"))[1];
    const positions = [...f.db.records.entries()].filter(([path]) => path.startsWith("escrowFundingPositions/"));
    for (const [path] of positions) f.db.records.delete(path);
    for (let i = 0; i < 60; i++) f.db.records.set(`escrowFundingPositions/zero-${i}`, { ...example, proposalId: `zero-${i}`, committed: "0" });
    for (const [path, row] of positions) f.db.records.set(path, row);
    f.client = new Proxy({}, { get() { assert.fail("All real balances are saved"); } });
    const result = await getFunderDashboard(f);
    assert.equal(result.commitments.length, 2); assert.equal(result.truncated.commitments, false);
    assert.equal(result.totals[0].committed, "100000000000");
  });

  it("does not reverify unchanged wallet allocations when only the saved block advances", async () => {
    const f = businessFixture(); await seedDashboardSnapshots(f);
    for (const [path, row] of f.db.records) if (path.startsWith("escrowFundingSummaries/")) row.blockNumber = 102;
    f.client = new Proxy({}, { get() { assert.fail("Unchanged allocation must not cause RPC"); } });
    const result = await getFunderDashboard(f);
    assert.equal(result.totals[0].committed, "100000000000"); assert.equal(result.totalsPartial, false);
    assert.equal(result.commitments[0].blockNumber, 100);
  });

});
