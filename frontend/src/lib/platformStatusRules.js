/**
 * Pure rules for the admin Platform Status tab: RPC endpoint description,
 * key-free error text, the browser RPC probe and the overall readiness verdict.
 *
 * The RPC helpers mirror firebase/functions/platformStatus.js so the browser
 * and server cards read the same way. The RPC transport policy is shared.
 */

import { RPC_ALLOWED_ORIGINS } from "../../../firebase/functions/rpcPolicy.js";

export const STATUS = Object.freeze({ OK: "ok", DEGRADED: "degraded", DOWN: "down", UNKNOWN: "unknown" });

export const HEALTH_LABELS = Object.freeze({
  ok: "Healthy",
  degraded: "Degraded",
  down: "Down",
  unknown: "Unknown",
});

export const EXPECTED_CHAIN_ID = 421614;
export const PUBLIC_DEFAULT_RPC_HOST = "sepolia-rollup.arbitrum.io";
// Baseline policy; CI also includes exact origins configured in GitHub Actions.
export const CSP_RPC_HOSTS = Object.freeze(RPC_ALLOWED_ORIGINS.map(origin => new URL(origin).host));

export const THRESHOLDS = Object.freeze({
  rpcTimeoutMs: 5_000,
  maxBlockAgeSeconds: 60,
  maxLatencyMs: 2_000,
  authTimeoutMs: 5_000,
});

const RANK = { ok: 0, unknown: 1, degraded: 2, down: 3 };
const MAX_ERROR_LENGTH = 200;

export function worstStatus(...statuses) {
  return statuses.flat().filter((status) => status in RANK)
    .reduce((worst, status) => (RANK[status] > RANK[worst] ? status : worst), STATUS.OK);
}

/** Provider and host only; the path and query can carry an API key. */
export function describeRpcEndpoint(url) {
  const value = String(url ?? "").trim();
  if (!value) return { provider: "public-default", host: PUBLIC_DEFAULT_RPC_HOST, configured: false };
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
    : host === PUBLIC_DEFAULT_RPC_HOST ? "public-default" : "custom";
  return { provider, host, configured: true };
}

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

function rpcDiagnostics(client) {
  const state = client?.transport?.rpcStatus;
  if (!state) return null;
  const safeHost = host => {
    if (typeof host !== "string") return null;
    try { const parsed = new URL(`https://${host}`); return parsed.host === host ? host : null; }
    catch { return null; }
  };
  return { activeHost: safeHost(state.activeHost), fallbackActive: state.fallbackActive === true,
    unavailableHosts: (Array.isArray(state.unavailableHosts) ? state.unavailableHosts : []).map(safeHost).filter(Boolean) };
}

/**
 * eth_chainId + latest block from this browser. Report the provider that
 * actually answered, and distinguish successful failover from a full outage.
 */
export async function probeRpc({ client, url, now = defaultNow, timeoutMs = THRESHOLDS.rpcTimeoutMs,
  production = false, allowedRpcHosts = CSP_RPC_HOSTS }) {
  let endpoint = describeRpcEndpoint(url);
  const notes = [];
  const cspBlocked = production && endpoint.provider !== "invalid" && !allowedRpcHosts.includes(endpoint.host);
  if (endpoint.provider === "public-default") {
    notes.push("VITE_ARBITRUM_SEPOLIA_RPC_URL is not set; the shared public Arbitrum endpoint is used.");
  }
  if (cspBlocked) {
    notes.push(`The production Content-Security-Policy does not allow ${endpoint.host} for RPC.`);
  }
  if (endpoint.provider === "invalid" && !client?.transport?.rpcStatus) {
    return { status: STATUS.DOWN, endpoint, notes, issues: ["VITE_ARBITRUM_SEPOLIA_RPC_URL is not a valid http(s) URL."] };
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
    const diagnostics = rpcDiagnostics(client);
    if (diagnostics?.activeHost) endpoint = describeRpcEndpoint(`https://${diagnostics.activeHost}`);
    if (diagnostics?.fallbackActive) {
      status = STATUS.DEGRADED;
      issues.push(`Using backup RPC ${diagnostics.activeHost || "endpoint"}.`);
    }
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
      ...(diagnostics || {}),
    };
  } catch (error) {
    return {
      status: STATUS.DOWN,
      endpoint,
      latencyMs: Math.max(0, Math.round(now() - started)),
      notes,
      issues: [`RPC unreachable from this browser: ${scrubError(error, url)}`],
      ...(rpcDiagnostics(client) || {}),
    };
  }
}

/**
 * Browser-side Firebase view: a forced ID-token refresh proves the Auth
 * service is reachable, and the config flags explain partial failures.
 */
export async function probeFirebaseClient({
  auth, configured = true, missingConfig = [], appCheckConfigured, storageConfigured, usingEmulators,
  production = false, now = defaultNow, timeoutMs = THRESHOLDS.authTimeoutMs,
}) {
  const config = { appCheckConfigured: Boolean(appCheckConfigured), storageConfigured: Boolean(storageConfigured),
    usingEmulators: Boolean(usingEmulators) };
  const notes = [];
  if (config.usingEmulators) notes.push("Emulator mode: Auth, Firestore, Functions and Storage are local emulators.");
  if (!configured) {
    return { status: STATUS.DOWN, latencyMs: null, config, notes,
      issues: [`Firebase web config is missing: ${missingConfig.join(", ") || "required keys"}.`] };
  }
  const issues = [];
  if (production && !config.usingEmulators && !config.appCheckConfigured) {
    issues.push("App Check is not configured; member actions that enforce App Check will be rejected.");
  }
  if (!config.storageConfigured) issues.push("Storage is not configured; attachment uploads are unavailable.");
  const user = auth?.currentUser;
  if (!user) {
    return { status: STATUS.DOWN, latencyMs: null, config, notes, issues: ["No Firebase Auth session in this browser.", ...issues] };
  }
  const started = now();
  try {
    await withTimeout(user.getIdToken(true), timeoutMs, "Auth token refresh");
    return { status: issues.length ? STATUS.DEGRADED : STATUS.OK, latencyMs: Math.max(0, Math.round(now() - started)),
      config, notes, issues };
  } catch (error) {
    return { status: STATUS.DOWN, latencyMs: Math.max(0, Math.round(now() - started)), config, notes,
      issues: [`Auth unreachable: ${scrubError(error)}`, ...issues] };
  }
}

function reason(label, check, fallback) {
  return `${label}: ${check?.issues?.[0] || fallback || HEALTH_LABELS[check?.status] || "Unknown"}`;
}

/**
 * Overall readiness from every card.
 * - Not ready: an RPC, the contract, Firestore, Functions or Auth is down.
 * - Degraded: anything else degraded (including a critical check that is
 *   unknown), a failed anchoring job, Alchemy reporting trouble or maintenance.
 * - Alchemy `unknown` (status page unreachable) is informational only.
 */
export function summarizeStatus({ server, serverError, browserRpc, firebaseClient }) {
  const blocking = [];
  const warnings = [];
  const critical = (label, check) => {
    if (!check) return;
    if (check.status === STATUS.DOWN) blocking.push(reason(label, check));
    else if (check.status === STATUS.DEGRADED || check.status === STATUS.UNKNOWN) warnings.push(reason(label, check));
  };
  const advisory = (label, check) => {
    if (check && (check.status === STATUS.DOWN || check.status === STATUS.DEGRADED)) warnings.push(reason(label, check));
  };

  if (serverError) {
    blocking.push(`Cloud Functions: ${serverError}`);
  } else if (server) {
    critical("Server RPC", server.serverRpc);
    for (const contract of server.contracts ?? []) critical(contract.name || "Contract", contract);
    critical("Firestore", server.firebase?.firestore);
    advisory("Anchoring queue", server.anchoring);
    advisory("Alchemy", server.alchemy);
  }
  critical("Browser RPC", browserRpc);
  critical("Firebase Auth", firebaseClient);

  const overall = blocking.length ? "not-ready" : warnings.length ? "degraded" : "ready";
  return { overall, reasons: [...blocking, ...warnings] };
}

export const OVERALL_LABELS = Object.freeze({
  ready: "Ready",
  degraded: "Degraded",
  "not-ready": "Not ready",
  checking: "Checking…",
});
