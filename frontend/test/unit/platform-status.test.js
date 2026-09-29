import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  STATUS, describeRpcEndpoint, probeFirebaseClient, probeRpc, scrubError, summarizeStatus,
} from "../../src/lib/platformStatusRules.js";

const KEY = "alch_BrowserKey987654321";
const ALCHEMY_URL = `https://arb-sepolia.g.alchemy.com/v2/${KEY}`;
const NOW = Date.parse("2026-09-29T05:00:00Z");

function client({ chainId = 421614, blockAge = 3, fail } = {}) {
  return {
    getChainId: async () => { if (fail) throw fail; return chainId; },
    getBlock: async () => ({ number: 99n, timestamp: BigInt(Math.floor(NOW / 1000) - blockAge) }),
  };
}

const ok = { status: "ok", issues: [] };
const healthyServer = {
  serverRpc: ok,
  contracts: [{ ...ok, name: "AuditRegistry" }],
  anchoring: { ...ok, counts: { pending: 0, confirmed: 3, failed: 0, "waiting-wallet": 0 } },
  alchemy: ok,
  firebase: { functions: ok, firestore: ok },
};

describe("Platform status rules: browser RPC", () => {
  it("[FUT-SXFPP-170] describes the endpoint by host only", () => {
    assert.deepEqual(describeRpcEndpoint(ALCHEMY_URL), { provider: "alchemy", host: "arb-sepolia.g.alchemy.com", configured: true });
    assert.equal(describeRpcEndpoint("").provider, "public-default");
    assert.equal(describeRpcEndpoint("https://rpc.example.org/x").provider, "custom");
    assert.equal(describeRpcEndpoint("javascript:alert(1)").provider, "invalid");
  });

  it("[FUT-SXFPP-171] scrubs keys from error text", () => {
    const text = scrubError(new Error(`HTTP request failed.\nURL: ${ALCHEMY_URL}`), ALCHEMY_URL);
    assert.ok(!text.includes(KEY));
    assert.ok(!scrubError({ message: `fetch ${ALCHEMY_URL} failed` }).includes(KEY));
  });

  it("[FUT-SXFPP-172] reports a healthy, stale and wrong-chain browser RPC", async () => {
    const times = [NOW - 80, NOW];
    const healthy = await probeRpc({ client: client(), url: ALCHEMY_URL, now: () => times.shift() ?? NOW });
    assert.equal(healthy.status, STATUS.OK);
    assert.equal(healthy.latencyMs, 80);
    assert.equal(healthy.blockNumber, "99");
    assert.equal((await probeRpc({ client: client({ blockAge: 90 }), url: ALCHEMY_URL, now: () => NOW })).status, STATUS.DEGRADED);
    assert.equal((await probeRpc({ client: client({ chainId: 1 }), url: ALCHEMY_URL, now: () => NOW })).status, STATUS.DOWN);
  });

  it("[FUT-SXFPP-173] is down without leaking the key when the RPC is unreachable", async () => {
    const result = await probeRpc({ client: client({ fail: new Error(`Failed to fetch ${ALCHEMY_URL}`) }), url: ALCHEMY_URL, now: () => NOW });
    assert.equal(result.status, STATUS.DOWN);
    assert.ok(!JSON.stringify(result).includes(KEY));
  });

  it("[FUT-SXFPP-174] warns that the production CSP blocks any RPC host but Alchemy", async () => {
    const fallback = await probeRpc({ client: client({ fail: new Error("Failed to fetch") }), url: "", now: () => NOW, production: true });
    assert.equal(fallback.status, STATUS.DOWN);
    assert.ok(fallback.notes.some((note) => /VITE_ARBITRUM_SEPOLIA_RPC_URL is not set/.test(note)));
    assert.ok(fallback.notes.some((note) => /Content-Security-Policy/.test(note)));
    const alchemy = await probeRpc({ client: client(), url: ALCHEMY_URL, now: () => NOW, production: true });
    assert.deepEqual(alchemy.notes, []);
    const local = await probeRpc({ client: client(), url: "", now: () => NOW, production: false });
    assert.ok(!local.notes.some((note) => /Content-Security-Policy/.test(note)));
  });
});

describe("Platform status rules: Firebase client", () => {
  const user = (getIdToken) => ({ currentUser: { getIdToken } });
  const flags = { appCheckConfigured: true, storageConfigured: true, usingEmulators: false };

  it("[FUT-SXFPP-175] forces a token refresh to prove Auth is reachable", async () => {
    let forced;
    const result = await probeFirebaseClient({ auth: user(async (force) => { forced = force; return "token"; }), ...flags, now: () => NOW });
    assert.equal(forced, true);
    assert.equal(result.status, STATUS.OK);
    assert.deepEqual(result.config, flags);
  });

  it("[FUT-SXFPP-176] is down without a session, config or a reachable Auth service", async () => {
    assert.equal((await probeFirebaseClient({ auth: { currentUser: null }, ...flags })).status, STATUS.DOWN);
    const missing = await probeFirebaseClient({ auth: null, configured: false, missingConfig: ["VITE_FIREBASE_API_KEY"], ...flags });
    assert.equal(missing.status, STATUS.DOWN);
    assert.match(missing.issues[0], /VITE_FIREBASE_API_KEY/);
    const failing = await probeFirebaseClient({ auth: user(async () => { throw new Error("auth/network-request-failed"); }), ...flags });
    assert.equal(failing.status, STATUS.DOWN);
  });

  it("[FUT-SXFPP-177] flags missing App Check in production and missing Storage, and notes emulator mode", async () => {
    const auth = user(async () => "token");
    const noAppCheck = await probeFirebaseClient({ auth, ...flags, appCheckConfigured: false, production: true });
    assert.equal(noAppCheck.status, STATUS.DEGRADED);
    const emulator = await probeFirebaseClient({ auth, ...flags, appCheckConfigured: false, usingEmulators: true, production: true });
    assert.equal(emulator.status, STATUS.OK);
    assert.match(emulator.notes[0], /Emulator mode/);
    assert.equal((await probeFirebaseClient({ auth, ...flags, storageConfigured: false })).status, STATUS.DEGRADED);
  });
});

describe("Platform status rules: overall readiness", () => {
  it("[FUT-SXFPP-178] is ready when every check passes", () => {
    assert.deepEqual(summarizeStatus({ server: healthyServer, browserRpc: ok, firebaseClient: ok }), { overall: "ready", reasons: [] });
  });

  it("[FUT-SXFPP-179] is not ready when a critical check is down, listing blocking reasons first", () => {
    const summary = summarizeStatus({
      server: { ...healthyServer, anchoring: { status: "degraded", issues: ["1 anchoring job failed in the last 7 days."] } },
      browserRpc: { status: "down", issues: ["RPC unreachable from this browser: Failed to fetch"] },
      firebaseClient: ok,
    });
    assert.equal(summary.overall, "not-ready");
    assert.match(summary.reasons[0], /^Browser RPC: RPC unreachable/);
    assert.match(summary.reasons[1], /^Anchoring queue: 1 anchoring job failed/);
  });

  it("[FUT-SXFPP-180] is not ready when the status function fails", () => {
    const summary = summarizeStatus({ serverError: "Administrator privilege required.", browserRpc: ok, firebaseClient: ok });
    assert.equal(summary.overall, "not-ready");
    assert.equal(summary.reasons[0], "Cloud Functions: Administrator privilege required.");
  });

  it("[FUT-SXFPP-181] treats contract, Firestore and Auth outages as blocking", () => {
    for (const server of [
      { ...healthyServer, contracts: [{ name: "AuditRegistry", status: "down", issues: ["No contract bytecode"] }] },
      { ...healthyServer, firebase: { functions: ok, firestore: { status: "down", issues: [] } } },
    ]) {
      assert.equal(summarizeStatus({ server, browserRpc: ok, firebaseClient: ok }).overall, "not-ready");
    }
    assert.equal(summarizeStatus({ server: healthyServer, browserRpc: ok, firebaseClient: { status: "down", issues: [] } }).overall, "not-ready");
  });

  it("[FUT-SXFPP-182] is degraded for maintenance, unknown critical checks or Alchemy trouble, but ignores an unreachable Alchemy page", () => {
    const maintenance = { ...healthyServer, firebase: { functions: ok, firestore: { status: "degraded", issues: ["Registry maintenance is active; member actions are paused."] } } };
    assert.equal(summarizeStatus({ server: maintenance, browserRpc: ok, firebaseClient: ok }).overall, "degraded");
    const unknownContract = { ...healthyServer, contracts: [{ name: "AuditRegistry", status: "unknown", issues: [] }] };
    assert.equal(summarizeStatus({ server: unknownContract, browserRpc: ok, firebaseClient: ok }).overall, "degraded");
    const alchemyDown = { ...healthyServer, alchemy: { status: "down", issues: ["Alchemy reports Arbitrum: major outage."] } };
    assert.equal(summarizeStatus({ server: alchemyDown, browserRpc: ok, firebaseClient: ok }).overall, "degraded");
    const alchemyUnknown = { ...healthyServer, alchemy: { status: "unknown", issues: ["Alchemy status page unavailable"] } };
    assert.equal(summarizeStatus({ server: alchemyUnknown, browserRpc: ok, firebaseClient: ok }).overall, "ready");
  });
});
