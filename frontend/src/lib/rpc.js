import { createPublicClient, fallback, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { createArbitrumRpcTransport, getRpcUrls } from "../../../firebase/functions/rpcPolicy.js";

const viteEnv = import.meta.env ?? {};
export const BROWSER_RPC_URL = viteEnv.VITE_ARBITRUM_SEPOLIA_RPC_URL?.trim() ?? "";
export const BROWSER_RPC_BACKUP_URLS = viteEnv.VITE_ARBITRUM_SEPOLIA_RPC_BACKUP_URLS?.trim() ?? "";

/** The wallet simulations, receipt reads and status probe share this policy. */
export function createBrowserRpcTransport(options = {}) {
  return createArbitrumRpcTransport({ http, fallback, primaryUrl: BROWSER_RPC_URL,
    backupUrls: BROWSER_RPC_BACKUP_URLS, ...options });
}

/**
 * Every browser read - contract state, blocks, receipts, fee estimates - goes
 * through one failover client. Concurrent contract reads are batched through
 * Multicall3, so verifying an escrow's thirty fields costs a few RPC requests
 * rather than thirty. Receipts are polled every 4 s, as wagmi did: viem's own
 * default for Arbitrum's 250 ms blocks is 500 ms, eight times the load on the
 * rate-limited public endpoints.
 */
export function createBrowserPublicClient({ transport = createBrowserRpcTransport(), ...options } = {}) {
  return createPublicClient({ chain: arbitrumSepolia, batch: { multicall: true }, pollingInterval: 4_000,
    transport, ...options });
}

export const browserPublicClient = createBrowserPublicClient();

export function browserRpcUrls(options = {}) {
  return getRpcUrls({ primaryUrl: BROWSER_RPC_URL, backupUrls: BROWSER_RPC_BACKUP_URLS, ...options });
}
