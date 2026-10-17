// Keep this module independent of viem: the browser and Functions use their own
// installed version and inject its transport constructors.
export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
export const DEFAULT_RPC_BACKUP_URLS = Object.freeze([
  "https://sepolia-rollup.arbitrum.io/rpc",
  "https://arbitrum-sepolia-rpc.publicnode.com",
]);
export const RPC_ALLOWED_ORIGINS = Object.freeze([
  "https://arb-sepolia.g.alchemy.com",
  "https://sepolia-rollup.arbitrum.io",
  "https://arbitrum-sepolia-rpc.publicnode.com",
]);

function normalizeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) return null;
    url.hash = "";
    if (url.pathname === "/" && !url.search) return url.origin;
    return url.href;
  } catch { return null; }
}

function parseBackups(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  if (value.trim().startsWith("[")) {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  }
  return value.split(",");
}

/** Configured primary, configured backups, then public backups, without duplicates. */
export function getRpcUrls({ primaryUrl, backupUrls, defaultBackupUrls = DEFAULT_RPC_BACKUP_URLS } = {}) {
  return [...new Set([primaryUrl, ...parseBackups(backupUrls), ...defaultBackupUrls]
    .map(normalizeUrl).filter(Boolean))];
}

function errorCauses(error) {
  const causes = [];
  const seen = new Set();
  for (let cause = error; cause && typeof cause === "object" && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    causes.push(cause);
  }
  return causes;
}

/** Only endpoint availability failures may cross to another provider. */
function canFailOver(error) {
  const causes = errorCauses(error);
  const errorText = (cause) => `${cause.shortMessage || cause.message || ""} ${cause.details || ""}`;
  if (causes.some((cause) => [3, 4001, 5000, -32003].includes(cause.code)
    || /execution reverted|\breverted\b|user rejected|user denied/i.test(errorText(cause)))) return false;
  if (causes.some((cause) => ["RpcEndpointUnavailableError", "RpcEndpointChainError", "RpcEndpointLogRangeError"].includes(cause.name))) return true;
  if (causes.some((cause) => [-32700, -32600, -32601, -32602, -32004, -32006, 4100, 4200].includes(cause.code))) return false;
  if (causes.some((cause) => [429, -32005, -32002, -32603].includes(cause.code)
    || /rate.?limit|too many requests|capacity limit exceeded|monthly capacity|compute units|\bquota\b/i.test(errorText(cause)))) return true;
  return causes.some((cause) => cause.name === "TimeoutError"
    || (cause.name === "HttpRequestError" && (!cause.status || [401, 402, 403, 408, 413, 429].includes(cause.status) || cause.status >= 500)));
}

// Providers can report a plan's log range limit as "invalid request/params".
// Classify it at the actual request so chain validation and other methods keep
// their original errors. The fallback callback only receives the resulting error.
function logRangeRequestError(error, method, host) {
  if (method !== "eth_getLogs" || !errorCauses(error).some((cause) => {
    if (![-32600, -32602].includes(cause.code)) return false;
    const text = `${cause.shortMessage || cause.message || ""} ${cause.details || ""}`;
    return /\bblock[\s-]+range\b/i.test(text)
      && /\b(?:up to|at most|limited to|maximum(?: of)?|limit of)\s+(?:a\s+)?[\d,]+\s+blocks?\b/i.test(text);
  })) return error;
  const limit = new Error(`RPC endpoint ${host} cannot serve the requested log block range.`, { cause: error });
  limit.name = "RpcEndpointLogRangeError";
  return limit;
}

function unavailableError(host) {
  const error = new Error(`RPC endpoint ${host} is temporarily unavailable.`);
  error.name = "RpcEndpointUnavailableError";
  return error;
}

// Dev and test counter. Off unless a caller enables it. Counts methods only;
// scopes are page paths or callable names, never endpoint URLs.
let rpcStatsEnabled = false;
let rpcScope = () => "unscoped";
let rpcScopeStore = null;
const rpcCounts = new Map();

export function enableRpcStats({ scope } = {}) {
  rpcStatsEnabled = true;
  if (scope) rpcScope = typeof scope === "function" ? scope : () => scope;
}

export function disableRpcStats() {
  rpcStatsEnabled = false;
}

export function setRpcScope(scope) {
  rpcScope = typeof scope === "function" ? scope : () => scope;
}

/** Optional AsyncLocalStorage-shaped store: `{ run(name, fn), getStore() }`. */
export function bindRpcScopeStore(store) {
  rpcScopeStore = store ?? null;
}

export function withRpcScope(name, fn) {
  if (rpcScopeStore?.run) return rpcScopeStore.run(name, fn);
  const previous = rpcScope;
  rpcScope = () => name;
  const restore = () => { rpcScope = previous; };
  try {
    const result = fn();
    return result && typeof result.then === "function" ? result.finally(restore) : (restore(), result);
  } catch (error) {
    restore();
    throw error;
  }
}

export function resetRpcStats() {
  rpcCounts.clear();
}

export function readRpcStats() {
  const scopes = {};
  for (const [scope, methods] of rpcCounts) scopes[scope] = Object.fromEntries(methods);
  return scopes;
}

function currentRpcScope() {
  const stored = rpcScopeStore?.getStore?.();
  if (typeof stored === "string" && stored) return stored;
  try { return rpcScope() || "unscoped"; }
  catch { return "unscoped"; }
}

function recordRpcCall(method) {
  if (!rpcStatsEnabled || typeof method !== "string") return;
  const scope = String(currentRpcScope()).slice(0, 120);
  let methods = rpcCounts.get(scope);
  if (!methods) { methods = new Map(); rpcCounts.set(scope, methods); }
  methods.set(method, (methods.get(method) ?? 0) + 1);
}

/**
 * Cap in-flight HTTP requests. A failed request releases its slot so later
 * reads still run. Individual contract reads are not capped here: a multicall
 * wave is one request.
 */
export function limitRpcConcurrency(request, concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("A positive HTTP concurrency is required.");
  let active = 0;
  const waiting = [];
  const start = (args, options) => {
    active += 1;
    return Promise.resolve(request(args, options)).finally(() => {
      active -= 1;
      waiting.shift()?.();
    });
  };
  return (args, options) => {
    if (active < concurrency) return start(args, options);
    return new Promise((resolve, reject) => {
      waiting.push(() => { start(args, options).then(resolve, reject); });
    });
  };
}

// Share overlapping identical reads, then immediately discard their results.
// A new read after settlement always contacts the chain again. Writes, nonce
// reads and gas estimates are deliberately excluded from coalescing.
const COALESCED_READ_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_call", "eth_getBalance", "eth_getCode",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getLogs",
  "eth_getTransactionByHash", "eth_getTransactionReceipt",
]);

/**
 * One attempt per endpoint, with no background timers or viem retry loops.
 * Before using an endpoint, verify its chain and cache that validation. Failed
 * endpoints cool down briefly so a broken primary does not delay every read.
 * Signed transaction bytes are passed through unchanged; application reverts
 * and wallet/transaction rejection stop immediately.
 */
export function createArbitrumRpcTransport({
  http, fallback, primaryUrl, backupUrls, timeoutMs = 3_000,
  cooldownMs = 15_000, chainValidationTtlMs = 300_000,
  now = () => Date.now(), defaultBackupUrls = DEFAULT_RPC_BACKUP_URLS,
  httpConcurrency = 8, overlapChainCheck = false,
} = {}) {
  if (typeof http !== "function" || typeof fallback !== "function") throw new TypeError("RPC transport constructors are required.");
  const urls = getRpcUrls({ primaryUrl, backupUrls, defaultBackupUrls });
  if (!urls.length) throw new TypeError("At least one valid HTTP(S) RPC endpoint is required.");
  const preferredUrl = normalizeUrl(primaryUrl) || (String(primaryUrl || "").trim() ? null : urls[0]);
  return (context) => {
    const states = urls.map((url) => ({ url, host: new URL(url).host, unavailableUntil: 0, validatedUntil: 0, validation: null }));
    const rpcStatus = { activeHost: null, fallbackActive: false, unavailableHosts: [] };
    const updateUnavailable = () => {
      rpcStatus.unavailableHosts = [...new Set(states.filter((state) => state.unavailableUntil > now()).map((state) => state.host))];
    };
    const transports = states.map((state) => {
      const transport = http(state.url, { timeout: timeoutMs, retryCount: 0 })({ ...context, timeout: timeoutMs, retryCount: 0 });
      const send = limitRpcConcurrency((args, options) => {
        recordRpcCall(args?.method);
        return transport.request(args, options);
      }, httpConcurrency);
      const request = async (args, options) => {
        updateUnavailable();
        if (state.unavailableUntil > now()) throw unavailableError(state.host);
        try {
          const ensureChain = () => {
            if (state.validatedUntil > now()) return null;
            if (!state.validation) {
              state.validation = (async () => {
                const chainId = await send({ method: "eth_chainId" }, { retryCount: 0 });
                if (Number(chainId) !== ARBITRUM_SEPOLIA_CHAIN_ID) {
                  const error = new Error(`RPC endpoint ${state.host} is not on Arbitrum Sepolia (${ARBITRUM_SEPOLIA_CHAIN_ID}).`);
                  error.name = "RpcEndpointChainError";
                  throw error;
                }
                state.validatedUntil = now() + chainValidationTtlMs;
                return chainId;
              })();
            }
            const validation = state.validation;
            return validation.finally(() => {
              if (state.validation === validation) state.validation = null;
            });
          };
          const deliver = async (value) => {
            let response;
            try {
              response = await value;
            } catch (error) {
              throw logRangeRequestError(error, args.method, state.host);
            }
            if (args.method === "eth_chainId" && Number(response) !== ARBITRUM_SEPOLIA_CHAIN_ID) {
              const error = new Error(`RPC endpoint ${state.host} is not on Arbitrum Sepolia (${ARBITRUM_SEPOLIA_CHAIN_ID}).`);
              error.name = "RpcEndpointChainError";
              throw error;
            }
            state.unavailableUntil = 0;
            rpcStatus.activeHost = state.host;
            rpcStatus.fallbackActive = state.url !== preferredUrl;
            updateUnavailable();
            return response;
          };
          if (args.method === "eth_chainId") {
            const chainCheck = ensureChain();
            if (chainCheck) return await deliver(chainCheck);
          } else if (overlapChainCheck && state.validatedUntil <= now()) {
            // The chain check shares this wait. Its result is required before the
            // read is returned, so a wrong chain never becomes page data.
            const chainCheck = ensureChain();
            const settled = send(args, { ...options, retryCount: 0 }).then(
              (value) => ({ value }),
              (error) => ({ error }),
            );
            await chainCheck;
            const outcome = await settled;
            if (outcome.error) return await deliver(Promise.reject(outcome.error));
            return await deliver(outcome.value);
          }
          const chainCheck = ensureChain();
          if (chainCheck) await chainCheck;
          return await deliver(send(args, { ...options, retryCount: 0 }));
        } catch (error) {
          if (canFailOver(error)) {
            state.unavailableUntil = now() + cooldownMs;
            state.validatedUntil = 0;
            if (rpcStatus.activeHost === state.host) {
              rpcStatus.activeHost = null;
              rpcStatus.fallbackActive = false;
            }
            updateUnavailable();
          }
          throw error;
        }
      };
      return () => ({ ...transport, request });
    });
    const transport = fallback(transports, {
      rank: false, retryCount: 0, shouldThrow: (error) => !canFailOver(error),
    })({ ...context, retryCount: 0, timeout: timeoutMs });
    const request = transport.request;
    const pendingReads = new Map();
    const coalescedRequest = (args, options) => {
      let key;
      if (COALESCED_READ_METHODS.has(args.method)) {
        try { key = JSON.stringify([args.method, args.params ?? []]); } catch { /* Non-JSON requests bypass sharing. */ }
      }
      if (key && pendingReads.has(key)) return pendingReads.get(key);
      const pending = Promise.resolve().then(() => request(args, { ...options, retryCount: 0 }));
      if (key) {
        pendingReads.set(key, pending);
        const clear = () => { if (pendingReads.get(key) === pending) pendingReads.delete(key); };
        pending.then(clear, clear);
      }
      return pending;
    };
    return { ...transport, request: coalescedRequest,
      value: { ...transport.value, rpcStatus } };
  };
}
