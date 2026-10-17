import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { loadFundingContext, readVerifiedFunding } from "../escrowFunding.js";
import { prepareStoredProposal } from "../proposalAuditPayload.js";
import { listActionItems } from "../proposalQueues.js";
import { resetImmutableChainCache } from "../immutableChainCache.js";
import { openFundingFixture, owner, researcher } from "./fixtures/openFundingFixture.js";

function countHttp(client) {
  const http = [];
  let active = 0, rounds = 0;
  const track = async (method, run) => {
    if (active === 0) rounds += 1;
    active += 1;
    http.push(method);
    try {
      await new Promise(resolve => setTimeout(resolve, 1));
      return await run();
    } finally { active -= 1; }
  };
  let pending = [], scheduled = false;
  const flush = () => {
    scheduled = false;
    const batch = pending.splice(0);
    if (!batch.length) return;
    void track("eth_call", async () => {
      await Promise.all(batch.map(async item => {
        try { item.resolve(await item.run()); }
        catch (error) { item.reject(error); }
      }));
    });
  };
  const wrap = (method, run) => (...args) => track(method, () => run(...args));
  client.readContract = request => new Promise((resolve, reject) => {
    pending.push({ run: () => client._read(request), resolve, reject });
    if (!scheduled) { scheduled = true; queueMicrotask(flush); }
  });
  return { http, rounds: () => rounds, wrap };
}

function mainActions(extra = 0) {
  const f = openFundingFixture();
  f.posting.opportunityType = "business-problem";
  f.db.records.set(`problems/${f.posting.id}`, f.posting);
  for (const [index, proposal] of f.proposals.entries()) {
    proposal.opportunityType = "business-problem";
    f.expected[index] = prepareStoredProposal(proposal, { registryConfig: f.config });
    f.db.records.set(`proposals/${proposal.id}`, proposal);
  }
  for (let index = 0; index < extra; index += 1) {
    const copy = { ...f.proposals[0], id: `proposal-extra-${index}` };
    f.db.records.set(`proposals/${copy.id}`, copy);
  }
  const read = f.client.readContract.bind(f.client);
  f.client._read = read;
  const counted = countHttp(f.client);
  f.client.getBlock = counted.wrap("eth_getBlockByNumber", f.client.getBlock.bind(f.client));
  f.client.getBlockNumber = counted.wrap("eth_blockNumber", f.client.getBlockNumber.bind(f.client));
  f.client.getChainId = counted.wrap("eth_chainId", f.client.getChainId.bind(f.client));
  f.client.getTransactionReceipt = counted.wrap("eth_getTransactionReceipt", f.client.getTransactionReceipt.bind(f.client));
  return { ...f, counted };
}

describe("on-chain read budgets", () => {
  it("[BUT-SXFPP-178] reads one verified escrow in at most 8 HTTP requests", async () => {
    resetImmutableChainCache();
    const f = mainActions();
    const context = await loadFundingContext({ ...f, uid: researcher, proposalId: f.proposals[0].id });
    f.counted.http.length = 0;
    await readVerifiedFunding({ ...f, ...context, blockNumber: 100n });
    assert.ok(f.counted.http.length <= 8, `${f.counted.http.length} HTTP requests`);
    assert.ok(f.counted.http.length < 37);
  });

  it("[BUT-SXFPP-179] does not let the immutable cache satisfy a prepare preflight", async () => {
    resetImmutableChainCache();
    const f = mainActions();
    const context = await loadFundingContext({ ...f, uid: researcher, proposalId: f.proposals[0].id });
    await readVerifiedFunding({ ...f, ...context, blockNumber: 100n, allowImmutableCache: true });
    f.calls.length = 0;
    await readVerifiedFunding({ ...f, ...context, blockNumber: 101n, allowImmutableCache: false });
    assert.ok(f.calls.some(call => call.functionName === "fundingFactory"));
  });

  it("[BUT-SXFPP-180] lists ten escrow proposals in at most 40 HTTP requests and skips cached linkage on the next poll", async () => {
    resetImmutableChainCache();
    const f = mainActions(9);
    const now = Timestamp.fromMillis(Number(f.state.timestamp) * 1000);
    const first = await listActionItems({ ...f, uid: owner, now });
    assert.equal(first.unavailableEscrows, 9);
    assert.ok(f.counted.http.length <= 40, `${f.counted.http.length} HTTP requests: ${f.counted.http.join(",")}`);
    const verifiedEntity = f.expected[0].entityId;
    const linkageFor = calls => calls.filter(call => call.functionName === "proposalEscrow" && call.args?.[0] === verifiedEntity).length;
    assert.ok(linkageFor(f.calls) >= 1);
    f.counted.http.length = 0;
    f.calls.length = 0;
    const second = await listActionItems({ ...f, uid: owner, now });
    assert.equal(linkageFor(f.calls), 0);
    assert.equal(second.unavailableEscrows, first.unavailableEscrows);
    assert.ok(f.calls.some(call => call.functionName === "state" || call.functionName === "totalDeposited"));
    assert.ok(f.counted.http.length <= 40);
    assert.equal(f.counted.http.filter(method => method === "eth_getTransactionReceipt").length, 0);
  });
});
