import { httpsCallable } from "firebase/functions";
import { createPublicClient, http } from "viem";
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

const viteEnv = import.meta.env ?? {};
const BROWSER_RPC_URL = viteEnv.VITE_ARBITRUM_SEPOLIA_RPC_URL?.trim() ?? "";
const IS_PRODUCTION_BUILD = Boolean(viteEnv.PROD);

/** Server-side checks: server RPC, AuditRegistry, anchoring queue, Alchemy and Firestore. */
export async function fetchPlatformStatus() {
  requireFirebase();
  const { data } = await httpsCallable(functions, "adminGetPlatformStatus")({});
  return data;
}

/**
 * Probes the RPC the frontend itself uses, from this browser. A dedicated client with no retries keeps the
 * latency honest and fails fast.
 */
export async function probeBrowserRpc({ url = BROWSER_RPC_URL } = {}) {
  const client = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(url || undefined, { timeout: THRESHOLDS.rpcTimeoutMs, retryCount: 0 }),
  });
  return probeRpc({ client, url, production: IS_PRODUCTION_BUILD });
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
