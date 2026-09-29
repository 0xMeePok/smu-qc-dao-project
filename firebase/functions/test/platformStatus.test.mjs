import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, HttpRequestError } from "viem";
import registry from "../auditRegistry.contract.json" with { type: "json" };
import {
  STATUS, collectPlatformStatus, describeRpcEndpoint, probeAlchemyStatus, probeAnchoringQueue,
  probeContract, probeFirestore, probeRpc, scrubError, worstStatus,
} from "../platformStatus.js";

const KEY = "alch_SecretKey1234567890";
const ALCHEMY_URL = `https://arb-sepolia.g.alchemy.com/v2/${KEY}`;
const ADDRESS = registry.address;
const NOW = Date.parse("2026-09-29T05:00:00Z");

function clock(...ticks) {
  const values = [...ticks];
  return () => (values.length > 1 ? values.shift() : values[0]);
}

function rpcClient({ chainId = 421614, blockAge = 2, number = 123n, fail, delay = 0 } = {}) {
  return {
    getChainId: async () => {
      if (fail) throw fail;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return chainId;
    },
    getBlock: async () => ({ number, timestamp: BigInt(Math.floor(NOW / 1000) - blockAge) }),
  };
}

function revert(errorName) {
  const data = errorName
    ? { abiItem: { type: "error", name: errorName, inputs: [] }, args: [], errorName }
    : undefined;
  const cause = new ContractFunctionRevertedError({ abi: registry.abi, functionName: "getOpportunity" });
  // viem decodes `data` from the revert bytes; set it directly for a deterministic fixture.
  cause.data = data;
  return new ContractFunctionExecutionError(cause, { abi: registry.abi, functionName: "getOpportunity", args: [] });
}

function httpError(url = ALCHEMY_URL) {
  return new HttpRequestError({ url, status: 401, body: { method: "eth_chainId" }, details: "Unauthorized" });
}

describe("Platform status: endpoint description and scrubbing", () => {
  it("classifies Alchemy, custom, public-default and invalid RPC URLs by host only", () => {
    assert.deepEqual(describeRpcEndpoint(ALCHEMY_URL), { provider: "alchemy", host: "arb-sepolia.g.alchemy.com", configured: true });
    assert.deepEqual(describeRpcEndpoint("https://rpc.example.org/path?key=abc"), { provider: "custom", host: "rpc.example.org", configured: true });
    assert.deepEqual(describeRpcEndpoint(""), { provider: "public-default", host: "sepolia-rollup.arbitrum.io", configured: false });
    assert.deepEqual(describeRpcEndpoint(undefined).provider, "public-default");
    assert.equal(describeRpcEndpoint("https://sepolia-rollup.arbitrum.io/rpc").provider, "public-default");
    assert.equal(describeRpcEndpoint("not a url").provider, "invalid");
    assert.equal(describeRpcEndpoint("ftp://x.example").provider, "invalid");
    assert.equal(describeRpcEndpoint("https://evil-alchemy.com.attacker.io/v2/x").provider, "custom");
  });

  it("never returns an RPC key from a viem error that embeds the full URL", () => {
    const error = httpError();
    assert.ok(error.message.includes(KEY), "fixture must contain the key to be meaningful");
    for (const text of [scrubError(error, ALCHEMY_URL), scrubError(error), scrubError(new Error(`failed at ${ALCHEMY_URL} now`))]) {
      assert.ok(!text.includes(KEY), text);
    }
    assert.match(scrubError(new Error(`failed at ${ALCHEMY_URL}`), ALCHEMY_URL), /arb-sepolia\.g\.alchemy\.com/);
    assert.ok(scrubError(new Error("x".repeat(500))).length <= 200);
  });

  it("ranks statuses with unknown between ok and degraded", () => {
    assert.equal(worstStatus(), STATUS.OK);
    assert.equal(worstStatus(STATUS.OK, STATUS.UNKNOWN), STATUS.UNKNOWN);
    assert.equal(worstStatus([STATUS.UNKNOWN, STATUS.DEGRADED]), STATUS.DEGRADED);
    assert.equal(worstStatus(STATUS.DEGRADED, STATUS.DOWN, "bogus"), STATUS.DOWN);
  });
});

describe("Platform status: RPC probe", () => {
  it("reports a healthy RPC with block, age and latency", async () => {
    const result = await probeRpc({ client: rpcClient(), url: ALCHEMY_URL, now: clock(NOW - 120, NOW) });
    assert.equal(result.status, STATUS.OK);
    assert.equal(result.chainId, 421614);
    assert.equal(result.blockNumber, "123");
    assert.equal(result.blockAgeSeconds, 2);
    assert.equal(result.latencyMs, 120);
    assert.equal(result.endpoint.provider, "alchemy");
    assert.deepEqual(result.issues, []);
    assert.doesNotThrow(() => JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes(KEY));
  });

  it("is degraded for a stale block or a slow response", async () => {
    const stale = await probeRpc({ client: rpcClient({ blockAge: 61 }), url: ALCHEMY_URL, now: clock(NOW, NOW) });
    assert.equal(stale.status, STATUS.DEGRADED);
    assert.match(stale.issues[0], /61s old/);
    const slow = await probeRpc({ client: rpcClient(), url: ALCHEMY_URL, now: clock(NOW - 2_500, NOW) });
    assert.equal(slow.status, STATUS.DEGRADED);
    assert.match(slow.issues[0], /2500 ms/);
  });

  it("is down on the wrong chain, a transport error or a timeout, without leaking the key", async () => {
    const wrong = await probeRpc({ client: rpcClient({ chainId: 1 }), url: ALCHEMY_URL, now: clock(NOW, NOW) });
    assert.equal(wrong.status, STATUS.DOWN);
    assert.match(wrong.issues[0], /chain 1/);
    const failed = await probeRpc({ client: rpcClient({ fail: httpError() }), url: ALCHEMY_URL, now: clock(NOW, NOW) });
    assert.equal(failed.status, STATUS.DOWN);
    assert.ok(!JSON.stringify(failed).includes(KEY));
    const timeout = await probeRpc({ client: rpcClient({ delay: 200 }), url: ALCHEMY_URL, now: clock(NOW, NOW), timeoutMs: 20 });
    assert.equal(timeout.status, STATUS.DOWN);
    assert.match(timeout.issues[0], /timed out/);
  });

  it("notes the public default and rejects an invalid URL without calling the client", async () => {
    const fallback = await probeRpc({ client: rpcClient(), url: "", now: clock(NOW, NOW) });
    assert.equal(fallback.status, STATUS.OK);
    assert.match(fallback.notes[0], /public Arbitrum endpoint/);
    const invalid = await probeRpc({ client: { getChainId: () => assert.fail("must not call") }, url: "nope", now: clock(NOW) });
    assert.equal(invalid.status, STATUS.DOWN);
  });
});

describe("Platform status: contract probe", () => {
  const deployment = { address: ADDRESS, blockNumber: 308652359, transactionHash: `0x${"a".repeat(64)}`,
    deployedAt: "2026-09-14T02:09:29.344Z", verificationUrl: `https://sepolia.arbiscan.io/address/${ADDRESS}#code` };
  const client = (overrides) => ({ getCode: async () => "0x6080", readContract: async () => { throw revert("InvalidInput"); }, ...overrides });

  it("is ok when bytecode exists and the empty-id read reverts with InvalidInput", async () => {
    const result = await probeContract({ client: client(), address: ADDRESS, abi: registry.abi, deployment });
    assert.equal(result.status, STATUS.OK);
    assert.equal(result.bytecodePresent, true);
    assert.equal(result.abiResponds, true);
    assert.equal(result.deployment.blockNumber, "308652359");
    assert.equal(result.explorerUrl, `https://sepolia.arbiscan.io/address/${ADDRESS}#code`);
  });

  it("detects the InvalidInput revert through viem's real error chain", async () => {
    const error = revert("InvalidInput");
    assert.ok(error instanceof BaseError);
    const result = await probeContract({ client: client({ readContract: async () => { throw error; } }), address: ADDRESS, abi: registry.abi });
    assert.equal(result.abiResponds, true);
  });

  it("is down when no bytecode is deployed", async () => {
    const result = await probeContract({ client: client({ getCode: async () => undefined }), address: ADDRESS, abi: registry.abi });
    assert.equal(result.status, STATUS.DOWN);
    assert.equal(result.bytecodePresent, false);
  });

  it("is degraded for an unexpected revert or a successful read", async () => {
    const other = await probeContract({ client: client({ readContract: async () => { throw revert("AccessDenied"); } }), address: ADDRESS, abi: registry.abi });
    assert.equal(other.status, STATUS.DEGRADED);
    assert.match(other.issues[0], /AccessDenied/);
    const bare = await probeContract({ client: client({ readContract: async () => { throw revert(null); } }), address: ADDRESS, abi: registry.abi });
    assert.equal(bare.status, STATUS.DEGRADED);
    const returned = await probeContract({ client: client({ readContract: async () => ({}) }), address: ADDRESS, abi: registry.abi });
    assert.equal(returned.status, STATUS.DEGRADED);
  });

  it("is unknown on a network error and down on invalid address configuration", async () => {
    const network = await probeContract({ client: client({ getCode: async () => { throw httpError(); } }), address: ADDRESS, abi: registry.abi, secrets: [ALCHEMY_URL] });
    assert.equal(network.status, STATUS.UNKNOWN);
    assert.ok(!JSON.stringify(network).includes(KEY));
    const invalid = await probeContract({ client: client(), resolveAddress: () => { throw new Error("AuditRegistry configuration is invalid."); }, abi: registry.abi });
    assert.equal(invalid.status, STATUS.DOWN);
    assert.match(invalid.issues[0], /configuration is invalid/);
  });

  it("omits deployment metadata that describes a different address", async () => {
    const result = await probeContract({ client: client(), address: `0x${"1".repeat(40)}`, abi: registry.abi, deployment });
    assert.equal(result.deployment, null);
  });
});

function countDb(jobs, { fail } = {}) {
  const calls = [];
  return {
    calls,
    collection(name) {
      const filters = [];
      const query = {
        where(field, op, value) { filters.push([field, op, value]); return query; },
        count() {
          return {
            async get() {
              if (fail) throw fail;
              calls.push({ name, filters: [...filters] });
              const count = jobs.filter((job) => filters.every(([field, op, value]) => (op === "=="
                ? job[field] === value : job[field] >= value))).length;
              return { data: () => ({ count }) };
            },
          };
        },
      };
      return query;
    },
  };
}

describe("Platform status: anchoring queue", () => {
  const day = 86_400_000;
  const jobs = [
    { status: "pending", updatedAt: NOW - day },
    { status: "confirmed", updatedAt: NOW - 2 * day },
    { status: "confirmed", updatedAt: NOW - 7 * day },
    { status: "confirmed", updatedAt: NOW - 7 * day - 1 },
    { status: "failed", updatedAt: NOW - 8 * day },
    { status: "waiting-wallet", updatedAt: NOW },
  ];

  it("counts each status inside the 7-day window only", async () => {
    const db = countDb(jobs);
    const result = await probeAnchoringQueue({ db, collection: "proposalAuditJobs", toTimestamp: (ms) => ms, now: () => NOW });
    assert.equal(result.status, STATUS.OK);
    assert.deepEqual(result.counts, { pending: 1, confirmed: 2, failed: 0, "waiting-wallet": 1 });
    assert.equal(result.windowDays, 7);
    assert.equal(result.since, new Date(NOW - 7 * day).toISOString());
    assert.ok(db.calls.every((call) => call.name === "proposalAuditJobs"));
  });

  it("is degraded when any job failed in the window", async () => {
    const result = await probeAnchoringQueue({ db: countDb([...jobs, { status: "failed", updatedAt: NOW }]),
      collection: "proposalAuditJobs", toTimestamp: (ms) => ms, now: () => NOW });
    assert.equal(result.status, STATUS.DEGRADED);
    assert.match(result.issues[0], /1 anchoring job failed/);
  });

  it("is down when the count query fails", async () => {
    const result = await probeAnchoringQueue({ db: countDb([], { fail: new Error("FAILED_PRECONDITION: index") }),
      collection: "proposalAuditJobs", toTimestamp: (ms) => ms, now: () => NOW });
    assert.equal(result.status, STATUS.DOWN);
    assert.equal(result.counts, null);
  });
});

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function statusFetch({ indicator = "none", arbitrum = "operational", apse = "operational", byName = false, failSummary, failComponents } = {}) {
  const requested = [];
  const fetchImpl = async (url, init) => {
    requested.push({ url, init });
    if (url.endsWith("/status.json")) {
      if (failSummary) throw failSummary;
      return jsonResponse({ status: { indicator, description: indicator === "none" ? "All Systems Operational" : "Minor Service Outage" } });
    }
    if (failComponents) throw failComponents;
    return jsonResponse({ components: [
      { id: byName ? "new-id-1" : "7rh2qgx0p450", name: "Arbitrum", status: arbitrum },
      { id: byName ? "new-id-2" : "bjzh4bnhsnt8", name: "AP SE", status: apse },
      { id: "9sndrv6702lc", name: "Solana", status: "major_outage" },
    ] });
  };
  return { fetchImpl, requested };
}

describe("Platform status: Alchemy service status", () => {
  it("is ok when the relevant components are operational, ignoring unrelated chains", async () => {
    const { fetchImpl, requested } = statusFetch();
    const result = await probeAlchemyStatus({ fetch: fetchImpl });
    assert.equal(result.status, STATUS.OK);
    assert.equal(result.overall.description, "All Systems Operational");
    assert.deepEqual(result.components.map((item) => [item.key, item.status]), [["arbitrum", "ok"], ["apSoutheast", "ok"]]);
    assert.deepEqual(requested.map((item) => item.url), [
      "https://status.alchemy.com/api/v2/status.json", "https://status.alchemy.com/api/v2/components.json",
    ]);
    assert.ok(requested.every((item) => item.init.signal instanceof AbortSignal));
  });

  it("maps component outages and falls back to matching by name", async () => {
    const partial = await probeAlchemyStatus({ fetch: statusFetch({ arbitrum: "partial_outage", byName: true }).fetchImpl });
    assert.equal(partial.status, STATUS.DEGRADED);
    assert.match(partial.issues[0], /Arbitrum: partial outage/);
    const major = await probeAlchemyStatus({ fetch: statusFetch({ apse: "major_outage" }).fetchImpl });
    assert.equal(major.status, STATUS.DOWN);
  });

  it("uses the overall indicator when components are unavailable", async () => {
    const result = await probeAlchemyStatus({ fetch: statusFetch({ indicator: "minor", failComponents: new Error("boom") }).fetchImpl });
    assert.equal(result.status, STATUS.DEGRADED);
    assert.equal(result.components.every((item) => item.status === STATUS.UNKNOWN), true);
  });

  it("is unknown when the status page is unreachable, returns non-JSON or times out", async () => {
    const down = await probeAlchemyStatus({ fetch: statusFetch({ failSummary: new Error("ENOTFOUND"), failComponents: new Error("ENOTFOUND") }).fetchImpl });
    assert.equal(down.status, STATUS.UNKNOWN);
    assert.match(down.issues[0], /unavailable/);
    const garbage = await probeAlchemyStatus({ fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }) });
    assert.equal(garbage.status, STATUS.UNKNOWN);
    const http500 = await probeAlchemyStatus({ fetch: async () => jsonResponse({}, { ok: false, status: 503 }) });
    assert.equal(http500.status, STATUS.UNKNOWN);
    const slow = await probeAlchemyStatus({ fetch: () => new Promise(() => {}), timeoutMs: 20 });
    assert.equal(slow.status, STATUS.UNKNOWN);
  });
});

function docDb({ data, fail, delay = 0 } = {}) {
  return {
    collection: (name) => ({
      doc: (id) => ({
        async get() {
          assert.equal(`${name}/${id}`, "maintenanceState/registryCutover");
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (fail) throw fail;
          return { exists: Boolean(data), data: () => data };
        },
      }),
    }),
  };
}

describe("Platform status: Firestore probe", () => {
  it("is ok with latency when maintenance is off", async () => {
    const result = await probeFirestore({ db: docDb(), now: clock(NOW - 40, NOW) });
    assert.deepEqual(result, { status: STATUS.OK, latencyMs: 40, maintenanceActive: false, issues: [] });
  });

  it("is degraded while registry maintenance is active", async () => {
    const result = await probeFirestore({ db: docDb({ data: { active: true } }), now: clock(NOW, NOW) });
    assert.equal(result.status, STATUS.DEGRADED);
    assert.equal(result.maintenanceActive, true);
  });

  it("is down on error or timeout", async () => {
    assert.equal((await probeFirestore({ db: docDb({ fail: new Error("UNAVAILABLE") }), now: clock(NOW, NOW) })).status, STATUS.DOWN);
    assert.equal((await probeFirestore({ db: docDb({ delay: 100 }), now: clock(NOW, NOW), timeoutMs: 10 })).status, STATUS.DOWN);
  });
});

describe("Platform status: collected snapshot", () => {
  it("returns every check even when some probes fail, as JSON-safe data without the key", async () => {
    const db = {
      collection(name) {
        if (name === "maintenanceState") return docDb().collection(name);
        return countDb([], { fail: new Error("index missing") }).collection(name);
      },
    };
    const client = { ...rpcClient({ fail: httpError() }), getCode: async () => { throw httpError(); } };
    const result = await collectPlatformStatus({
      client, rpcUrl: ALCHEMY_URL, db, auditJobsCollection: "proposalAuditJobs", toTimestamp: (ms) => ms,
      registry: { ...registry, deployment: { blockNumber: 1 } }, resolveRegistryAddress: () => ADDRESS,
      fetch: statusFetch().fetchImpl, now: () => NOW,
    });
    assert.equal(result.checkedAt, new Date(NOW).toISOString());
    assert.equal(result.serverRpc.status, STATUS.DOWN);
    assert.equal(result.contracts.length, 1);
    assert.equal(result.contracts[0].status, STATUS.UNKNOWN);
    assert.equal(result.contracts[0].deployment.blockNumber, "1");
    assert.equal(result.anchoring.status, STATUS.DOWN);
    assert.equal(result.alchemy.status, STATUS.OK);
    assert.equal(result.firebase.functions.status, STATUS.OK);
    assert.equal(result.firebase.firestore.status, STATUS.OK);
    const json = JSON.stringify(result);
    assert.ok(!json.includes(KEY));
  });
});
