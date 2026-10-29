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

/**
 * Callables a member waits on with nothing else to look at. Each accepts
 * { warmup: true }, which reads no member data and returns nothing.
 *
 * Chosen from measured p50-vs-p95 latency: warm, every one of these answers in
 * under half a second, so almost all of a cold caller's 3-6 seconds is the
 * cold start itself. Everything else on the platform warms in under a second
 * and is not worth a ping.
 */
const WARMABLE_CALLABLES = new Set([
  "listActionItems",          // +5.6s cold - every workspace landing
  "listMyProposalQueue",      // +4.0s cold - the developer workspace
  "prepareOpenFundingAction", // +3.5s cold - click to wallet prompt
  "prepareEscrowDeposit",     // +2.8s cold - click to wallet prompt
  "getOpenFundingSummary",    // +2.1s cold - the grant panel
  "exchangePrivySession",     // +1.6s cold - sign-in, blocks everything
]);

// Cloud Run reclaimed this project's idle instances after about 15 minutes, so
// two minutes leaves roughly a 7x margin. Below this buys nothing: the window
// is already far wider than the gap.
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

/**
 * Keeps every warmable callable awake for as long as this tab is open and
 * visible, so the first click of a session does not pay a cold start either.
 *
 * Hidden tabs are skipped, matching LIVE_DASHBOARD_OPTIONS: a backgrounded tab
 * has nobody waiting on it, and pinging from one would multiply the cost by
 * every window a member left open. Returns a stop function.
 */
export function startKeepWarm({ interval = CALLABLE_WARM_INTERVAL_MS } = {}) {
  if (!enabled || !functions) return () => {};
  const ping = () => {
    if (document.visibilityState === "hidden") return;
    for (const name of WARMABLE_CALLABLES) prewarmCallable(name);
  };
  ping();
  const timer = window.setInterval(ping, interval);
  document.addEventListener("visibilitychange", ping);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", ping);
  };
}
