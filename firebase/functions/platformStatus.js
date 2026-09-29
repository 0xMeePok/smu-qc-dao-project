import { BaseError, ContractFunctionRevertedError } from "viem";
import { arbitrumSepolia } from "viem/chains";

/**
 * Platform status probes for the admin "Platform Status" tab.
 *
 * Every probe is dependency-injected (client, db, fetch, clock) so it can be
 * tested without a network, and every probe resolves rather than throws: a
 * failing check is reported as a result, never allowed to hide the others.
 * Results are JSON-safe (no bigint) and never contain an RPC key.
 */

export const STATUS = Object.freeze({ OK: "ok", DEGRADED: "degraded", DOWN: "down", UNKNOWN: "unknown" });

export const EXPECTED_CHAIN_ID = arbitrumSepolia.id;
export const PUBLIC_DEFAULT_RPC_URL = arbitrumSepolia.rpcUrls.default.http[0];

export const THRESHOLDS = Object.freeze({
  rpcTimeoutMs: 5_000,
  maxBlockAgeSeconds: 60,
  maxLatencyMs: 2_000,
  alchemyTimeoutMs: 3_000,
  firestoreTimeoutMs: 5_000,
  anchoringWindowDays: 7,
});

export const ANCHORING_STATUSES = Object.freeze(["pending", "confirmed", "failed", "waiting-wallet"]);

export const ALCHEMY_STATUS_BASE = "https://status.alchemy.com/api/v2";
export const ALCHEMY_STATUS_PAGE = "https://status.alchemy.com";
// Statuspage component ids are stable; names are the fallback if Alchemy re-creates one.
export const ALCHEMY_COMPONENTS = Object.freeze([
  { key: "arbitrum", id: "7rh2qgx0p450", name: "Arbitrum" },
  { key: "apSoutheast", id: "bjzh4bnhsnt8", name: "AP SE" },
]);

const ZERO_ID = `0x${"0".repeat(64)}`;
const RANK = { [STATUS.OK]: 0, [STATUS.UNKNOWN]: 1, [STATUS.DEGRADED]: 2, [STATUS.DOWN]: 3 };
const MAX_ERROR_LENGTH = 200;

/** Worst of the given statuses; `unknown` ranks between ok and degraded. */
export function worstStatus(...statuses) {
  return statuses.flat().filter((status) => status in RANK)
    .reduce((worst, status) => (RANK[status] > RANK[worst] ? status : worst), STATUS.OK);
}

/**
 * Classifies an RPC URL and returns only its host. The path and query are
 * dropped because providers such as Alchemy carry the API key there.
 */
export function describeRpcEndpoint(url) {
  const value = String(url ?? "").trim();
  if (!value) {
    return { provider: "public-default", host: new URL(PUBLIC_DEFAULT_RPC_URL).host, configured: false };
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { provider: "invalid", host: "", configured: true };
  }
  if (!/^https?:$/.test(parsed.protocol)) return { provider: "invalid", host: "", configured: true };
  const host = parsed.host.toLowerCase();
  const provider = /(^|\.)alchemy\.com$|(^|\.)alchemyapi\.io$/.test(parsed.hostname.toLowerCase())
    ? "alchemy"
    : host === new URL(PUBLIC_DEFAULT_RPC_URL).host ? "public-default" : "custom";
  return { provider, host, configured: true };
}

/**
 * A short, key-free error message. viem errors embed the full request URL
 * (including an Alchemy key) in `message`, so only the first line of
 * `shortMessage` is used and any remaining URL is reduced to its origin.
 */
export function scrubError(error, secrets = []) {
  let text = String(error?.shortMessage || error?.message || error || "Unknown error").split("\n")[0];
  for (const secret of [secrets].flat()) {
    const value = String(secret ?? "").trim();
    if (!value) continue;
    let replacement = "[rpc]";
    try { replacement = new URL(value).host; } catch { /* keep placeholder */ }
    text = text.split(value).join(replacement);
  }
  text = text.replace(/\b(https?|wss?):\/\/([^\s/"'?#]+)[^\s"']*/gi, "$1://$2");
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

export async function withTimeout(promise, ms, label = "Request") {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms.`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const defaultNow = () => Date.now();

/** eth_chainId + latest block through the given client, with latency and block age. */
export async function probeRpc({ client, url, now = defaultNow, timeoutMs = THRESHOLDS.rpcTimeoutMs }) {
  const endpoint = describeRpcEndpoint(url);
  const notes = endpoint.provider === "public-default"
    ? ["No RPC URL is configured; the shared public Arbitrum endpoint is used and may be rate limited."]
    : [];
  if (endpoint.provider === "invalid") {
    return { status: STATUS.DOWN, endpoint, notes, issues: ["The configured RPC URL is not a valid http(s) URL."] };
  }
  const started = now();
  try {
    const [chainId, block] = await withTimeout(
      Promise.all([client.getChainId(), client.getBlock({ blockTag: "latest" })]),
      timeoutMs,
      "RPC request",
    );
    const finished = now();
    const latencyMs = Math.max(0, Math.round(finished - started));
    const blockSeconds = Number(block.timestamp);
    const blockAgeSeconds = Math.max(0, Math.round(finished / 1000 - blockSeconds));
    const issues = [];
    let status = STATUS.OK;
    if (Number(chainId) !== EXPECTED_CHAIN_ID) {
      status = STATUS.DOWN;
      issues.push(`Connected to chain ${Number(chainId)}; expected Arbitrum Sepolia (${EXPECTED_CHAIN_ID}).`);
    } else {
      if (blockAgeSeconds > THRESHOLDS.maxBlockAgeSeconds) {
        status = STATUS.DEGRADED;
        issues.push(`Latest block is ${blockAgeSeconds}s old.`);
      }
      if (latencyMs > THRESHOLDS.maxLatencyMs) {
        status = STATUS.DEGRADED;
        issues.push(`Slow response (${latencyMs} ms).`);
      }
    }
    return {
      status,
      endpoint,
      chainId: Number(chainId),
      blockNumber: String(block.number),
      blockTimestamp: new Date(blockSeconds * 1000).toISOString(),
      blockAgeSeconds,
      latencyMs,
      notes,
      issues,
    };
  } catch (error) {
    return {
      status: STATUS.DOWN,
      endpoint,
      latencyMs: Math.max(0, Math.round(now() - started)),
      notes,
      issues: [`RPC unreachable: ${scrubError(error, url)}`],
    };
  }
}

export function explorerAddressUrl(address) {
  return `https://sepolia.arbiscan.io/address/${address}#code`;
}

/** Deployment metadata only when it describes the address actually in use. */
function deploymentFor(address, deployment) {
  if (!deployment || String(deployment.address ?? address).toLowerCase() !== String(address).toLowerCase()) return null;
  const { blockNumber, transactionHash, deployedAt, verificationUrl } = deployment;
  return {
    blockNumber: blockNumber == null ? null : String(blockNumber),
    transactionHash: transactionHash || null,
    deployedAt: deployedAt || null,
    verificationUrl: verificationUrl || null,
  };
}

function revertReason(error) {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? { name: reverted.data?.errorName ?? null } : null;
}

/**
 * Reachability for one contract: bytecode is present, and a read against an
 * id that cannot exist reverts with the registry's own `InvalidInput()` error.
 * That shows the live bytecode answers like the synced ABI, costs no gas and
 * needs no real record.
 */
export async function probeContract({
  client, name = "AuditRegistry", address, resolveAddress, abi, deployment,
  timeoutMs = THRESHOLDS.rpcTimeoutMs, secrets = [],
}) {
  let target = address;
  try {
    if (resolveAddress) target = resolveAddress();
  } catch (error) {
    return { name, status: STATUS.DOWN, address: null, bytecodePresent: false, abiResponds: false,
      issues: [scrubError(error, secrets)] };
  }
  const base = {
    name,
    address: target,
    deployment: deploymentFor(target, deployment),
    explorerUrl: explorerAddressUrl(target),
  };
  let code;
  try {
    code = await withTimeout(client.getCode({ address: target }), timeoutMs, "Bytecode lookup");
  } catch (error) {
    return { ...base, status: STATUS.UNKNOWN, bytecodePresent: null, abiResponds: null,
      issues: [`Could not reach the network to check this contract: ${scrubError(error, secrets)}`] };
  }
  if (!code || code === "0x") {
    return { ...base, status: STATUS.DOWN, bytecodePresent: false, abiResponds: false,
      issues: ["No contract bytecode at this address on Arbitrum Sepolia."] };
  }
  try {
    await withTimeout(
      client.readContract({ address: target, abi, functionName: "getOpportunity", args: [ZERO_ID] }),
      timeoutMs,
      "Contract read",
    );
    return { ...base, status: STATUS.DEGRADED, bytecodePresent: true, abiResponds: false,
      issues: ["A probe read for an empty id returned data; the deployed contract may not match the synced ABI."] };
  } catch (error) {
    const reverted = revertReason(error);
    if (reverted?.name === "InvalidInput") {
      return { ...base, status: STATUS.OK, bytecodePresent: true, abiResponds: true, issues: [] };
    }
    if (reverted) {
      return { ...base, status: STATUS.DEGRADED, bytecodePresent: true, abiResponds: false,
        issues: [`Probe read reverted unexpectedly (${reverted.name || "no reason"}); the contract may not match the synced ABI.`] };
    }
    return { ...base, status: STATUS.UNKNOWN, bytecodePresent: true, abiResponds: null,
      issues: [`Probe read failed: ${scrubError(error, secrets)}`] };
  }
}

/** Anchoring job counts by status for jobs updated inside the recent window. */
export async function probeAnchoringQueue({
  db, collection, toTimestamp, now = defaultNow,
  windowDays = THRESHOLDS.anchoringWindowDays, timeoutMs = THRESHOLDS.firestoreTimeoutMs,
}) {
  const since = now() - windowDays * 86_400_000;
  const base = { windowDays, since: new Date(since).toISOString() };
  try {
    const cutoff = toTimestamp(since);
    const counts = await withTimeout(Promise.all(ANCHORING_STATUSES.map(async (status) => {
      const snapshot = await db.collection(collection).where("status", "==", status)
        .where("updatedAt", ">=", cutoff).count().get();
      return [status, Number(snapshot.data().count ?? 0)];
    })), timeoutMs, "Anchoring queue count");
    const byStatus = Object.fromEntries(counts);
    const issues = byStatus.failed > 0
      ? [`${byStatus.failed} anchoring job${byStatus.failed === 1 ? "" : "s"} failed in the last ${windowDays} days.`]
      : [];
    return { ...base, status: issues.length ? STATUS.DEGRADED : STATUS.OK, counts: byStatus, issues };
  } catch (error) {
    return { ...base, status: STATUS.DOWN, counts: null,
      issues: [`Could not read the anchoring queue: ${scrubError(error)}`] };
  }
}

const INDICATOR_STATUS = { none: STATUS.OK, minor: STATUS.DEGRADED, major: STATUS.DOWN, critical: STATUS.DOWN };
const COMPONENT_STATUS = {
  operational: STATUS.OK,
  degraded_performance: STATUS.DEGRADED,
  partial_outage: STATUS.DEGRADED,
  under_maintenance: STATUS.DEGRADED,
  major_outage: STATUS.DOWN,
};

async function fetchJson(fetchImpl, url, timeoutMs) {
  const response = await withTimeout(
    fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) }),
    timeoutMs,
    "Status page request",
  );
  if (!response?.ok) throw new Error(`Status page returned HTTP ${response?.status ?? "error"}.`);
  const body = await response.json();
  if (!body || typeof body !== "object") throw new Error("Status page returned an unexpected response.");
  return body;
}

/**
 * Alchemy's own reported health from its public Statuspage feed. The overall
 * indicator covers every chain Alchemy serves, so the status is driven by the
 * components this platform depends on, with the indicator as a fallback.
 */
export async function probeAlchemyStatus({ fetch: fetchImpl = globalThis.fetch, timeoutMs = THRESHOLDS.alchemyTimeoutMs } = {}) {
  const [summary, components] = await Promise.allSettled([
    fetchJson(fetchImpl, `${ALCHEMY_STATUS_BASE}/status.json`, timeoutMs),
    fetchJson(fetchImpl, `${ALCHEMY_STATUS_BASE}/components.json`, timeoutMs),
  ]);
  const indicator = summary.status === "fulfilled" ? String(summary.value.status?.indicator ?? "") : null;
  const overall = summary.status === "fulfilled"
    ? {
      indicator,
      description: String(summary.value.status?.description ?? "").slice(0, 120),
      status: INDICATOR_STATUS[indicator] ?? STATUS.UNKNOWN,
    }
    : null;
  const list = components.status === "fulfilled" && Array.isArray(components.value.components)
    ? components.value.components : null;
  const selected = ALCHEMY_COMPONENTS.map(({ key, id, name }) => {
    const match = list?.find((item) => item?.id === id)
      ?? list?.find((item) => String(item?.name ?? "").trim().toLowerCase() === name.toLowerCase());
    const raw = match ? String(match.status ?? "") : null;
    return { key, name, rawStatus: raw, status: raw ? COMPONENT_STATUS[raw] ?? STATUS.UNKNOWN : STATUS.UNKNOWN };
  });
  const issues = [];
  const found = selected.filter((item) => item.rawStatus);
  let status;
  if (found.length) {
    status = worstStatus(found.map((item) => item.status));
    for (const item of found) {
      if (item.status !== STATUS.OK) issues.push(`Alchemy reports ${item.name}: ${item.rawStatus.replace(/_/g, " ")}.`);
    }
  } else if (overall) {
    status = overall.status;
    if (status !== STATUS.OK) issues.push(`Alchemy reports: ${overall.description || indicator}.`);
  } else {
    status = STATUS.UNKNOWN;
    const reason = summary.status === "rejected" ? summary.reason : components.reason;
    issues.push(`Alchemy status page unavailable: ${scrubError(reason)}`);
  }
  return { status, overall, components: selected, pageUrl: ALCHEMY_STATUS_PAGE, issues };
}

/** Timed server-side Firestore read that also surfaces the registry maintenance flag. */
export async function probeFirestore({ db, now = defaultNow, timeoutMs = THRESHOLDS.firestoreTimeoutMs }) {
  const started = now();
  try {
    const snapshot = await withTimeout(db.collection("maintenanceState").doc("registryCutover").get(), timeoutMs, "Firestore read");
    const latencyMs = Math.max(0, Math.round(now() - started));
    const maintenanceActive = Boolean(snapshot.exists && snapshot.data()?.active);
    return {
      status: maintenanceActive ? STATUS.DEGRADED : STATUS.OK,
      latencyMs,
      maintenanceActive,
      issues: maintenanceActive ? ["Registry maintenance is active; member actions are paused."] : [],
    };
  } catch (error) {
    return { status: STATUS.DOWN, latencyMs: Math.max(0, Math.round(now() - started)), maintenanceActive: null,
      issues: [`Firestore unreachable: ${scrubError(error)}`] };
  }
}

/**
 * Runs every server-side probe in parallel. `Promise.allSettled` plus the
 * probes' own error handling means one failing check never hides the others.
 */
export async function collectPlatformStatus({
  client, rpcUrl, db, auditJobsCollection, toTimestamp, registry, resolveRegistryAddress,
  fetch: fetchImpl = globalThis.fetch, now = defaultNow,
}) {
  const settle = (result) => (result.status === "fulfilled"
    ? result.value
    : { status: STATUS.UNKNOWN, issues: [scrubError(result.reason, rpcUrl)] });
  const [serverRpc, contract, anchoring, alchemy, firestore] = await Promise.allSettled([
    probeRpc({ client, url: rpcUrl, now }),
    probeContract({ client, name: registry.contractName || "AuditRegistry", resolveAddress: resolveRegistryAddress,
      abi: registry.abi, deployment: registry.deployment ? { address: registry.address, ...registry.deployment } : null,
      secrets: [rpcUrl] }),
    probeAnchoringQueue({ db, collection: auditJobsCollection, toTimestamp, now }),
    probeAlchemyStatus({ fetch: fetchImpl }),
    probeFirestore({ db, now }),
  ]);
  return {
    checkedAt: new Date(now()).toISOString(),
    serverRpc: settle(serverRpc),
    contracts: [settle(contract)],
    anchoring: settle(anchoring),
    alchemy: settle(alchemy),
    firebase: { functions: { status: STATUS.OK }, firestore: settle(firestore) },
  };
}
