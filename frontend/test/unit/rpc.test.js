import assert from "node:assert/strict";
import { it } from "node:test";
import { custom } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { browserPublicClient, createBrowserPublicClient, createBrowserRpcTransport } from "../../src/lib/rpc.js";
import { auditErrorMessage, RPC_UNREACHABLE_MESSAGE } from "../../src/lib/errors.js";
import { classifyAuditError } from "../../src/lib/auditRegistry.js";

const primary = "https://primary.example.test/rpc";
const backup = "https://backup.example.test/rpc";
const owner = `0x${"1".repeat(40)}`;
const ownerAbi = [{ name: "owner", type: "function", stateMutability: "view", inputs: [],
  outputs: [{ type: "address" }] }];

function fixture(failure) {
  const calls = [];
  const fakeHttp = url => custom({ request: async ({ method }) => {
    calls.push({ url, method });
    if ((url === primary && failure === "unavailable") || failure === "all-down") {
      const error = new Error("Provider unavailable"); error.name = "HttpRequestError"; error.status = 503;
      throw error;
    }
    if (method === "eth_chainId") return "0x66eee";
    if (method === "eth_call" && failure === "revert") {
      const error = new Error("execution reverted"); error.code = 3; throw error;
    }
    if (method === "eth_call") return `0x${owner.slice(2).padStart(64, "0")}`;
    if (method === "eth_blockNumber") return "0x64";
    throw new Error("Unexpected RPC method");
  } }, { retryCount: 0 });
  const client = createBrowserPublicClient({ batch: { multicall: false },
    transport: createBrowserRpcTransport({ http: fakeHttp, primaryUrl: primary, backupUrls: backup, defaultBackupUrls: [] }) });
  return { calls, client };
}

it("the shipped browser client uses failover with both public backup endpoints", () => {
  const client = browserPublicClient;
  assert.equal(client.chain.id, arbitrumSepolia.id);
  // wagmi's interval, not viem's 500 ms default for Arbitrum's fast blocks.
  assert.equal(client.pollingInterval, 4_000);
  assert.equal(client.transport.type, "fallback");
  assert.ok(client.transport.transports.length >= 2);
  assert.ok(client.transport.rpcStatus);
});

it("contract reads recover on the backup and avoid the cooling-down primary on subsequent reads", async () => {
  const { client, calls } = fixture("unavailable");
  assert.equal(await client.readContract({ address: owner, abi: ownerAbi, functionName: "owner" }), owner);
  const initialPrimaryCalls = calls.filter(call => call.url === primary).length;
  assert.equal(await client.getBlockNumber(), 100n);
  assert.equal(calls.filter(call => call.url === primary).length, initialPrimaryCalls);
  assert.equal(client.transport.rpcStatus.activeHost, "backup.example.test");
  assert.equal(client.transport.rpcStatus.fallbackActive, true);
});

it("contract reverts are preserved without consulting another provider", async () => {
  const { client, calls } = fixture("revert");
  await assert.rejects(client.readContract({ address: owner, abi: ownerAbi, functionName: "owner" }), /reverted/);
  assert.equal(calls.some(call => call.url === backup), false);
});

it("an exhausted failover and its cached retry retain the reviewed network error message", async () => {
  const { client } = fixture("all-down");
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(client.readContract({ address: owner, abi: ownerAbi, functionName: "owner" }), error => {
      assert.equal(auditErrorMessage(error), RPC_UNREACHABLE_MESSAGE);
      assert.equal(classifyAuditError(error, { maxRetries: 2 }).category, "transient");
      assert.equal(classifyAuditError(error, { attempt: 0, maxRetries: 2 }).retryable, true);
      assert.equal(classifyAuditError(error, { attempt: 2, maxRetries: 2 }).retryable, false);
      return true;
    });
  }
});
