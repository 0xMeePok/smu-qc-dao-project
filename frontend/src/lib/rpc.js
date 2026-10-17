import { createPublicClient, fallback, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { createArbitrumRpcTransport, enableRpcStats, getRpcUrls } from "../../../firebase/functions/rpcPolicy.js";

const viteEnv = import.meta.env ?? {};
export const BROWSER_RPC_URL = viteEnv.VITE_ARBITRUM_SEPOLIA_RPC_URL?.trim() ?? "";
export const BROWSER_RPC_BACKUP_URLS = viteEnv.VITE_ARBITRUM_SEPOLIA_RPC_BACKUP_URLS?.trim() ?? "";

/** The wallet simulations, receipt reads and status probe share this policy. */
export function createBrowserRpcTransport(options = {}) {
  return createArbitrumRpcTransport({ http, fallback, primaryUrl: BROWSER_RPC_URL,
    backupUrls: BROWSER_RPC_BACKUP_URLS, overlapChainCheck: true, ...options });
}

/**
 * Every browser read - contract state, blocks, receipts, fee estimates - goes
 * through one failover client. Concurrent contract reads are batched through
 * Multicall3, so verifying an escrow's thirty fields costs a few RPC requests
 * rather than thirty. Receipts are polled every 4 s, as wagmi did: viem's own
 * default for Arbitrum's 250 ms blocks is 500 ms, eight times the load on the
 * rate-limited public endpoints.
 */
export const BROWSER_READ_BATCH = Object.freeze({ multicall: { batchSize: 1024, wait: 16 } });

export function createBrowserPublicClient({ transport = createBrowserRpcTransport(), ...options } = {}) {
  return createPublicClient({ chain: arbitrumSepolia, batch: BROWSER_READ_BATCH, pollingInterval: 4_000,
    transport, ...options });
}

/** Counts RPC methods by page path while developing. Tests enable the counter themselves. */
export function enableBrowserRpcStats() {
  enableRpcStats({ scope: () => (typeof location === "undefined" ? "browser" : location.pathname || "browser") });
}

export const browserPublicClient = createBrowserPublicClient();

const WARM_INTERVAL_MS = 60_000;
let warmedAt = -Infinity;
let warming = null;

/**
 * Opens the RPC connection and refreshes the transport's cached chain check
 * before a member clicks, so the first pre-wallet read does not also pay for
 * the TLS handshake and an eth_chainId round trip. Read-only, throttled, and
 * never throws: a failed warm-up leaves the normal checks to run on click.
 */
export function warmBrowserRpc({ publicClient = browserPublicClient, now = Date.now() } = {}) {
  if (warming) return warming;
  if (now - warmedAt < WARM_INTERVAL_MS) return Promise.resolve();
  warmedAt = now;
  warming = Promise.resolve().then(() => publicClient.getChainId()).then(() => {}, () => { warmedAt = -Infinity; })
    .finally(() => { warming = null; });
  return warming;
}

export function browserRpcUrls(options = {}) {
  return getRpcUrls({ primaryUrl: BROWSER_RPC_URL, backupUrls: BROWSER_RPC_BACKUP_URLS, ...options });
}
