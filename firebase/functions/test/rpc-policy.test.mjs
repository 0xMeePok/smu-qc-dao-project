import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { createPublicClient, fallback, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { createArbitrumRpcTransport, DEFAULT_RPC_BACKUP_URLS, getRpcUrls, RPC_ALLOWED_ORIGINS } from "../rpcPolicy.js";
import { probeRpc, STATUS } from "../platformStatus.js";

const CHAIN = "0x66eee";
const SECRET = "private-RPC-key";

// These fixtures never contact a real RPC or submit an actual transaction.
async function fixture(handler = () => ({})) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) {
      text += chunk;
      if (text.length > 10_000) { request.destroy(); return; }
    }
    const body = JSON.parse(text);
    calls.push(body);
    const reply = await handler(body, calls);
    if (reply.hold) return;
    response.writeHead(reply.status || 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id,
      ...(reply.error ? { error: reply.error } : {
        result: reply.result ?? (body.method === "eth_chainId" ? CHAIN : "0x42"),
      }) }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/v2/${SECRET}`;
  return { calls, url, host: new URL(url).host, close: async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

async function withFixtures(handlers, run) {
  const endpoints = [];
  try {
    for (const handler of handlers) endpoints.push(await fixture(handler));
    return await run(endpoints);
  } finally {
    await Promise.all(endpoints.map((endpoint) => endpoint.close()));
  }
}

function clientFor(endpoints, options = {}) {
  return createPublicClient({ chain: arbitrumSepolia, cacheTime: 0,
    transport: createArbitrumRpcTransport({ http, fallback,
      primaryUrl: endpoints[0].url,
      backupUrls: endpoints.slice(1).map((endpoint) => endpoint.url),
      // Keep fixture tests entirely local, including all-endpoints-down tests.
      defaultBackupUrls: [], timeoutMs: 60, ...options,
    }) });
}

const read = (client) => client.request({ method: "eth_blockNumber" });
const logRequest = { method: "eth_getLogs", params: [{
  address: "0x1111111111111111111111111111111111111111", fromBlock: "0x1", toBlock: "0x2710",
}] };
const logRangeLimit = "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. "
  + "Based on your parameters, this block range should work: [0x1, 0xa]. Upgrade to PAYG for expanded block range.";

describe("RPC configuration", () => {
  it("orders and deduplicates primary, comma-separated backups and public defaults", () => {
    assert.deepEqual(getRpcUrls({ primaryUrl: " https://arb-sepolia.g.alchemy.com/v2/abc ",
      backupUrls: `https://backup.example/rpc, https://backup.example/rpc, ${DEFAULT_RPC_BACKUP_URLS[0]}` }),
    ["https://arb-sepolia.g.alchemy.com/v2/abc", "https://backup.example/rpc", ...DEFAULT_RPC_BACKUP_URLS]);
  });

  it("accepts JSON arrays and rejects malformed, non-HTTP and credential URLs", () => {
    assert.deepEqual(getRpcUrls({ primaryUrl: "javascript:alert(1)", backupUrls: JSON.stringify([
      "https://backup.example/rpc", null, 12, "ftp://bad.example", "https://user:secret@bad.example", "not a url",
    ]) }), ["https://backup.example/rpc", ...DEFAULT_RPC_BACKUP_URLS]);
    assert.deepEqual(getRpcUrls({ backupUrls: "[broken json" }), DEFAULT_RPC_BACKUP_URLS);
    assert.deepEqual(getRpcUrls({ primaryUrl: DEFAULT_RPC_BACKUP_URLS[0], backupUrls: DEFAULT_RPC_BACKUP_URLS }), DEFAULT_RPC_BACKUP_URLS);
    assert.throws(() => createArbitrumRpcTransport({ http, fallback, defaultBackupUrls: [] }), /valid HTTP/);
    assert.throws(() => createArbitrumRpcTransport({}), /constructors/);
    assert.deepEqual(RPC_ALLOWED_ORIGINS, ["https://arb-sepolia.g.alchemy.com", "https://sepolia-rollup.arbitrum.io", "https://arbitrum-sepolia-rpc.publicnode.com"]);
  });

  it("deduplicates URL spelling and fragments without exposing paths in diagnostics", () => {
    assert.deepEqual(getRpcUrls({ primaryUrl: "https://RPC.EXAMPLE:443", backupUrls: "https://rpc.example/#ignored", defaultBackupUrls: [] }), ["https://rpc.example"]);
  });
});

describe("Arbitrum Sepolia RPC failover", () => {
  it("coalesces 20 overlapping identical reads, without retaining a stale result", async () => {
    let releaseRead;
    let notifyRead;
    const readStarted = new Promise(resolve => { notifyRead = resolve; });
    await withFixtures([async ({ method }) => {
      if (method === "eth_blockNumber" && !releaseRead) {
        notifyRead();
        return new Promise(resolve => { releaseRead = () => resolve({ result: "0x42" }); });
      }
      return { result: method === "eth_blockNumber" ? "0x43" : CHAIN };
    }], async endpoints => {
      const client = clientFor(endpoints, { timeoutMs: 500 });
      const pending = Promise.all(Array.from({ length: 20 }, () => read(client)));
      await readStarted;
      assert.equal(endpoints[0].calls.filter(call => call.method === "eth_blockNumber").length, 1);
      releaseRead();
      assert.deepEqual(await pending, Array(20).fill("0x42"));
      assert.equal(await read(client), "0x43");
      assert.deepEqual(endpoints[0].calls.map(call => call.method),
        ["eth_chainId", "eth_blockNumber", "eth_blockNumber"]);
    });
  });

  it("does not merge different call parameters, nonce reads, gas estimates or transaction submissions", async () => {
    await withFixtures([() => ({})], async endpoints => {
      const client = clientFor(endpoints);
      const requests = [
        { method: "eth_call", params: [{ to: "0x1111", data: "0xaaaa" }, "latest"] },
        { method: "eth_call", params: [{ to: "0x1111", data: "0xbbbb" }, "latest"] },
        { method: "eth_getTransactionCount", params: ["0x1111", "pending"] },
        { method: "eth_estimateGas", params: [{ to: "0x1111" }] },
        { method: "eth_sendRawTransaction", params: ["0x1234"] },
      ];
      await Promise.all(requests.flatMap(request => [client.request(request), client.request(request)]));
      assert.equal(endpoints[0].calls.filter(call => call.method === "eth_call").length, 2);
      for (const method of ["eth_getTransactionCount", "eth_estimateGas", "eth_sendRawTransaction"]) {
        assert.equal(endpoints[0].calls.filter(call => call.method === method).length, 2);
      }
    });
  });

  it("evicts a failed coalesced read so a corrected later attempt reaches the provider", async () => {
    let reads = 0;
    await withFixtures([({ method }) => method === "eth_call" && ++reads === 1
      ? { error: { code: 3, message: "execution reverted" } } : {}], async endpoints => {
      const client = clientFor(endpoints);
      const request = { method: "eth_call", params: [{ to: "0x1111", data: "0xaaaa" }, "latest"] };
      const results = await Promise.allSettled([client.request(request), client.request(request)]);
      assert.ok(results.every(result => result.status === "rejected"));
      assert.equal(await client.request(request), "0x42");
      assert.equal(endpoints[0].calls.filter(call => call.method === "eth_call").length, 2);
    });
  });

  it("keeps a healthy primary and caches chain validation across reads", async () => {
    await withFixtures([() => ({}), () => ({})], async (endpoints) => {
      const client = clientFor(endpoints);
      assert.equal(await read(client), "0x42");
      assert.equal(await read(client), "0x42");
      assert.deepEqual(endpoints[0].calls.map((call) => call.method), ["eth_chainId", "eth_blockNumber", "eth_blockNumber"]);
      assert.equal(endpoints[1].calls.length, 0);
      assert.deepEqual(client.transport.rpcStatus, { activeHost: endpoints[0].host, fallbackActive: false, unavailableHosts: [] });
    });
  });

  it("fails over a 503 primary once and skips it during cooldown", async () => {
    await withFixtures([() => ({ status: 503 }), () => ({})], async (endpoints) => {
      const client = clientFor(endpoints);
      assert.equal(await read(client), "0x42");
      assert.equal(await read(client), "0x42");
      assert.equal(endpoints[0].calls.length, 1);
      assert.equal(client.transport.rpcStatus.activeHost, endpoints[1].host);
      assert.equal(client.transport.rpcStatus.fallbackActive, true);
      assert.deepEqual(client.transport.rpcStatus.unavailableHosts, [endpoints[0].host]);
    });
  });

  it("retries a recovered primary after cooldown and refreshes its chain validation", async () => {
    let available = false;
    let now = 1_000;
    await withFixtures([() => ({ ...(available ? {} : { status: 503 }) }), () => ({})], async (endpoints) => {
      const client = clientFor(endpoints, { now: () => now, cooldownMs: 100 });
      await read(client);
      available = true;
      now += 101;
      assert.equal(await read(client), "0x42");
      assert.deepEqual(endpoints[0].calls.map((call) => call.method), ["eth_chainId", "eth_chainId", "eth_blockNumber"]);
      assert.equal(client.transport.rpcStatus.fallbackActive, false);
      assert.deepEqual(client.transport.rpcStatus.unavailableHosts, []);
    });
  });

  it("fails over a timed-out primary within the per-endpoint timeout", async () => {
    await withFixtures([() => ({ hold: true }), () => ({})], async (endpoints) => {
      const client = clientFor(endpoints, { timeoutMs: 35 });
      const started = Date.now();
      assert.equal(await read(client), "0x42");
      assert.ok(Date.now() - started < 600);
      assert.equal(endpoints[0].calls.length, 1);
      assert.equal(client.transport.rpcStatus.fallbackActive, true);
    });
  });

  it("fails over HTTP 429 and JSON-RPC rate limits without retrying the primary", async () => {
    for (const failure of [{ status: 429 }, { status: 402 }, { error: { code: -32005, message: "Rate limit exceeded" } },
      { error: { code: -32000, message: "Monthly capacity limit exceeded" } },
      { error: { code: -32000, message: "Compute units quota exceeded" } },
      { error: { code: -32000, message: "Rate limit exceeded" } }, { error: { code: 429, message: "Too many requests" } }]) {
      await withFixtures([() => failure, () => ({})], async (endpoints) => {
        const client = clientFor(endpoints);
        assert.equal(await read(client), "0x42");
        assert.equal(endpoints[0].calls.length, 1);
        assert.equal(client.transport.rpcStatus.activeHost, endpoints[1].host);
      });
    }
  });

  it("fails over provider log range limits once, preserving the query and using cooldown", async () => {
    for (const code of [-32600, -32602]) {
      await withFixtures([
        ({ method }) => method === "eth_getLogs" ? { error: { code, message: logRangeLimit } } : {},
        ({ method }) => method === "eth_getLogs" ? { result: [] } : {},
      ], async endpoints => {
        const client = clientFor(endpoints);
        assert.deepEqual(await client.request(logRequest), []);
        assert.deepEqual(await client.request(logRequest), []);
        assert.deepEqual(endpoints[0].calls.map(call => call.method), ["eth_chainId", "eth_getLogs"]);
        assert.deepEqual(endpoints[1].calls.map(call => call.method), ["eth_chainId", "eth_getLogs", "eth_getLogs"]);
        for (const endpoint of endpoints) {
          assert.ok(endpoint.calls.filter(call => call.method === "eth_getLogs")
            .every(call => JSON.stringify(call.params) === JSON.stringify(logRequest.params)));
        }
        assert.equal(client.transport.rpcStatus.activeHost, endpoints[1].host);
        assert.equal(client.transport.rpcStatus.fallbackActive, true);
        assert.deepEqual(client.transport.rpcStatus.unavailableHosts, [endpoints[0].host]);
      });
    }
  });

  it("keeps malformed log requests and contract reverts terminal", async () => {
    for (const error of [
      { code: -32600, message: "Invalid request" },
      { code: -32602, message: "Invalid block range: fromBlock must be less than or equal to toBlock" },
      { code: -32602, message: "Invalid params: block range must use hex values" },
      { code: -32601, message: logRangeLimit },
      { code: -32700, message: logRangeLimit },
      { code: 3, message: `execution reverted: ${logRangeLimit}` },
      { code: -32600, message: `execution reverted: ${logRangeLimit}` },
    ]) {
      await withFixtures([
        ({ method }) => method === "eth_chainId" ? {} : { error }, () => ({}),
      ], async endpoints => {
        const client = clientFor(endpoints);
        await assert.rejects(client.request(logRequest));
        assert.deepEqual(endpoints[0].calls.map(call => call.method), ["eth_chainId", "eth_getLogs"]);
        assert.equal(endpoints[1].calls.length, 0);
        assert.deepEqual(client.transport.rpcStatus.unavailableHosts, []);
      });
    }
  });

  it("does not apply log range failover to other methods or chain validation", async () => {
    for (const method of ["eth_blockNumber", "eth_call", "eth_sendRawTransaction", "eth_chainId"]) {
      await withFixtures([
        (body) => body.method === method ? { error: { code: -32600, message: logRangeLimit } } : {},
        () => ({}),
      ], async endpoints => {
        const client = clientFor(endpoints);
        await assert.rejects(client.request({ method, params: ["0x1234"] }));
        assert.equal(endpoints[1].calls.length, 0);
        assert.deepEqual(client.transport.rpcStatus.unavailableHosts, []);
      });
    }
    await withFixtures([() => ({ error: { code: -32600, message: logRangeLimit } }), () => ({})], async endpoints => {
      await assert.rejects(clientFor(endpoints).request(logRequest));
      assert.deepEqual(endpoints[0].calls.map(call => call.method), ["eth_chainId"]);
      assert.equal(endpoints[1].calls.length, 0);
    });
  });

  it("uses the tertiary endpoint after two failed providers", async () => {
    await withFixtures([() => ({ status: 503 }), () => ({ status: 429 }), () => ({})], async (endpoints) => {
      const client = clientFor(endpoints);
      assert.equal(await read(client), "0x42");
      assert.equal(client.transport.rpcStatus.activeHost, endpoints[2].host);
      assert.deepEqual(endpoints.map((endpoint) => endpoint.calls.length), [1, 1, 2]);
      assert.deepEqual(client.transport.rpcStatus.unavailableHosts, endpoints.slice(0, 2).map((endpoint) => endpoint.host));
    });
  });

  it("fails over when a validated primary later fails a real read", async () => {
    await withFixtures([(body) => body.method === "eth_chainId" ? {} : { status: 503 }, () => ({})], async (endpoints) => {
      const client = clientFor(endpoints);
      assert.equal(await read(client), "0x42");
      assert.deepEqual(endpoints.map((endpoint) => endpoint.calls.length), [2, 2]);
      assert.equal(client.transport.rpcStatus.activeHost, endpoints[1].host);
    });
  });

  it("fails after one attempt per unavailable endpoint, even when callers request retries", async () => {
    await withFixtures([() => ({ status: 503 }), () => ({ status: 503 }), () => ({ status: 503 })], async (endpoints) => {
      const client = clientFor(endpoints);
      await assert.rejects(client.request({ method: "eth_blockNumber" }, { retryCount: 3 }));
      assert.deepEqual(endpoints.map((endpoint) => endpoint.calls.length), [1, 1, 1]);
      assert.deepEqual(client.transport.rpcStatus, { activeHost: null, fallbackActive: false, unavailableHosts: endpoints.map((endpoint) => endpoint.host) });
      await assert.rejects(read(client));
      assert.deepEqual(endpoints.map((endpoint) => endpoint.calls.length), [1, 1, 1]);
    });
  });

  it("rejects a wrong-chain endpoint before any read and fails over to the expected chain", async () => {
    await withFixtures([() => ({ result: "0x1" }), () => ({})], async (endpoints) => {
      const client = clientFor(endpoints);
      assert.equal(await read(client), "0x42");
      assert.deepEqual(endpoints[0].calls.map((call) => call.method), ["eth_chainId"]);
      assert.equal(await client.getChainId(), 421614);
      assert.equal(client.transport.rpcStatus.activeHost, endpoints[1].host);
    });
  });

  it("refreshes expired chain validation and rejects all wrong-chain endpoints", async () => {
    let now = 1_000;
    let chain = CHAIN;
    await withFixtures([(body) => body.method === "eth_chainId" ? { result: chain } : {}, () => ({ result: "0x1" })], async (endpoints) => {
      const client = clientFor(endpoints, { now: () => now, chainValidationTtlMs: 100 });
      assert.equal(await read(client), "0x42");
      chain = "0x1";
      now += 101;
      await assert.rejects(read(client), /not on Arbitrum Sepolia/);
      assert.equal(endpoints[0].calls.filter((call) => call.method === "eth_blockNumber").length, 1);
      assert.equal(client.transport.rpcStatus.activeHost, null);
    });
  });

  it("shares in-flight chain validation between concurrent reads", async () => {
    await withFixtures([() => ({})], async (endpoints) => {
      const client = clientFor(endpoints);
      assert.deepEqual(await Promise.all([read(client), read(client), read(client)]), ["0x42", "0x42", "0x42"]);
      assert.equal(endpoints[0].calls.filter((call) => call.method === "eth_chainId").length, 1);
    });
  });

  it("preserves contract reverts, invalid params and wallet rejection without trying a backup", async () => {
    for (const error of [
      { code: -32000, message: "execution reverted", data: "0x12345678" },
      { code: -32603, message: "execution reverted", data: "0x12345678" },
      { code: 3, message: "execution reverted: InvalidInput" },
      { code: -32602, message: "Invalid params" },
      { code: -32602, message: "Invalid rate limit params" },
      { code: 4001, message: "User rejected the request" },
      { code: -32003, message: "Transaction rejected" },
    ]) {
      await withFixtures([(body) => body.method === "eth_chainId" ? {} : { error }, () => ({})], async (endpoints) => {
        const client = clientFor(endpoints);
        await assert.rejects(read(client));
        assert.equal(endpoints[0].calls.length, 2);
        assert.equal(endpoints[1].calls.length, 0);
        assert.deepEqual(client.transport.rpcStatus.unavailableHosts, []);
      });
    }
  });

  it("passes the same signed raw bytes to the backup after a transport failure", async () => {
    const rawBytes = "0x02deadbeef";
    await withFixtures([(body) => body.method === "eth_chainId" ? {} : { status: 503 }, () => ({})], async (endpoints) => {
      const client = clientFor(endpoints);
      await client.request({ method: "eth_sendRawTransaction", params: [rawBytes] });
      assert.deepEqual(endpoints.map((endpoint) => endpoint.calls.find((call) => call.method === "eth_sendRawTransaction").params), [[rawBytes], [rawBytes]]);
    });
  });

  it("reports only host names in diagnostics and health snapshots when using a backup", async () => {
    const now = Date.now();
    const block = { number: "0x42", timestamp: `0x${Math.floor(now / 1_000).toString(16)}` };
    await withFixtures([() => ({ status: 503 }), (body) => body.method === "eth_getBlockByNumber" ? { result: block } : {}], async (endpoints) => {
      const client = clientFor(endpoints);
      const result = await probeRpc({ client, url: endpoints[0].url, now: () => now });
      assert.equal(result.status, STATUS.DEGRADED);
      assert.equal(result.endpoint.host, endpoints[1].host);
      assert.equal(result.fallbackActive, true);
      assert.deepEqual(result.unavailableHosts, [endpoints[0].host]);
      assert.match(result.issues[0], /Using backup RPC/);
      for (const value of [client.transport.rpcStatus, result]) {
        assert.ok(!JSON.stringify(value).includes(SECRET));
        assert.ok(!JSON.stringify(value).includes("/v2/"));
      }
    });
  });
});
