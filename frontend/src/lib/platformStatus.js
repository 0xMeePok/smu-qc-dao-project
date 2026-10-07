import { httpsCallable } from "firebase/functions";
import { createPublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import {
  auth,
  functions,
  isAppCheckConfigured,
  isFirebaseConfigured,
  isStorageConfigured,
  isUsingEmulators,
  missingFirebaseConfig,
} from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { THRESHOLDS, probeFirebaseClient, probeRpc } from "./platformStatusRules.js";
import { BROWSER_RPC_URL, BROWSER_RPC_BACKUP_URLS, browserRpcUrls, createBrowserRpcTransport } from "./rpc.js";

const viteEnv = import.meta.env ?? {};
const IS_PRODUCTION_BUILD = Boolean(viteEnv.PROD);

/** Server-side checks: server RPC, AuditRegistry, anchoring queue, Alchemy and Firestore. */
export async function fetchPlatformStatus() {
  requireFirebase();
  const { data } = await httpsCallable(functions, "adminGetPlatformStatus")({});
  return data;
}

/**
 * Probe the same failover policy as wallet simulations and receipt reads.
 * Bound each chain validation/read so the full endpoint list fits the probe.
 */
export async function probeBrowserRpc({ url = BROWSER_RPC_URL, backupUrls = BROWSER_RPC_BACKUP_URLS } = {}) {
  const urls = browserRpcUrls({ primaryUrl: url, backupUrls });
  const client = createPublicClient({
    chain: arbitrumSepolia,
    cacheTime: 0,
    transport: createBrowserRpcTransport({ primaryUrl: url, backupUrls,
      timeoutMs: Math.max(1, Math.floor(THRESHOLDS.rpcTimeoutMs / (2 * urls.length + 1))) }),
  });
  return probeRpc({ client, url, production: IS_PRODUCTION_BUILD,
    allowedRpcHosts: urls.map(endpoint => new URL(endpoint).host) });
}

export async function probeFirebaseFromBrowser() {
  return probeFirebaseClient({
    auth,
    configured: isFirebaseConfigured,
    missingConfig: missingFirebaseConfig,
    appCheckConfigured: isAppCheckConfigured,
    storageConfigured: isStorageConfigured,
    usingEmulators: isUsingEmulators,
    production: IS_PRODUCTION_BUILD,
  });
}
