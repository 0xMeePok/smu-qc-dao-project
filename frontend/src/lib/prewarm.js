import { httpsCallable } from "firebase/functions";
import { AUDIT_REGISTRY_CHAIN_ID } from "../config/auditRegistry.js";
import { functions } from "./firebase.js";
import { createWalletAuditAdapters } from "./auditRegistry.js";
import { warmBrowserRpc } from "./rpc.js";

const viteEnv = import.meta.env ?? {};
// Unit and component tests drive mocked adapters; they never reach a live RPC.
const enabled = typeof window !== "undefined" && viteEnv.MODE !== "test";
const HASH = /^0x[0-9a-f]{64}$/i;

/**
 * Starts read-only work that a transaction button will repeat, before the
 * click: opens the RPC connection, refreshes the cached chain check, and reads
 * the mined audit transactions that identify each record's deployment. Every
 * check still runs again on click; these only make its round trips cheaper.
 * Never throws.
 */
export function prewarmTransaction({ records = [] } = {}) {
  if (!enabled) return;
  void warmBrowserRpc();
  let adapters;
  for (const record of records) {
    const hash = record?.audit?.transactionHash;
    if (!HASH.test(hash ?? "")) continue;
    adapters ??= createWalletAuditAdapters();
    adapters.getTransaction({ hash, chainId: Number(record.audit?.chainId ?? AUDIT_REGISTRY_CHAIN_ID) }).catch(() => {});
  }
}

// Callables that run between a member's click and the wallet prompt. Each
// accepts { warmup: true }, which reads no member data and returns nothing.
const WARMABLE_CALLABLES = new Set(["prepareEscrowDeposit", "prepareOpenFundingAction"]);
const CALLABLE_WARM_INTERVAL_MS = 120_000;
const warmedCallables = new Map();

/**
 * Wakes a pre-signature Cloud Function before the member clicks, so the click
 * does not pay its cold start. It never stands in for the real call: the
 * click still runs every server check. Throttled per function; never throws.
 */
export function prewarmCallable(name, { now = Date.now() } = {}) {
  if (!enabled || !WARMABLE_CALLABLES.has(name) || !functions) return;
  if (now - (warmedCallables.get(name) ?? -Infinity) < CALLABLE_WARM_INTERVAL_MS) return;
  warmedCallables.set(name, now);
  // Even a refusal (for example from an older deployment) has started an instance.
  void httpsCallable(functions, name)({ warmup: true }).catch(() => {});
}
