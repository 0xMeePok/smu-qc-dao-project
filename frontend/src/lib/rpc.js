import { fallback, http } from "viem";
import { createArbitrumRpcTransport, getRpcUrls } from "../../../firebase/functions/rpcPolicy.js";

const viteEnv = import.meta.env ?? {};
export const BROWSER_RPC_URL = viteEnv.VITE_ARBITRUM_SEPOLIA_RPC_URL?.trim() ?? "";
export const BROWSER_RPC_BACKUP_URLS = viteEnv.VITE_ARBITRUM_SEPOLIA_RPC_BACKUP_URLS?.trim() ?? "";

/** The wallet simulations, receipt reads and status probe share this policy. */
export function createBrowserRpcTransport(options = {}) {
  return createArbitrumRpcTransport({ http, fallback, primaryUrl: BROWSER_RPC_URL,
    backupUrls: BROWSER_RPC_BACKUP_URLS, ...options });
}

export function browserRpcUrls(options = {}) {
  return getRpcUrls({ primaryUrl: BROWSER_RPC_URL, backupUrls: BROWSER_RPC_BACKUP_URLS, ...options });
}
