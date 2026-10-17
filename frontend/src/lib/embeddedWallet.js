import { createWalletClient, custom, parseAbiItem } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { ENTRY_POINTS, decodeMemberCall, userOperationSucceeded } from "../../../firebase/functions/memberCall.js";
import { browserPublicClient } from "./rpc.js";

/**
 * The one wallet this app signs with: the signed-in member's Privy embedded
 * wallet. WalletContext publishes it here because the audit and escrow
 * adapters run outside React and still need to sign.
 */
let active = null;

export class WalletUnavailableError extends Error {
  constructor(message = "Your QC DAO wallet is not ready. Sign in with your email, then try again.") {
    super(message);
    this.name = "WalletUnavailableError";
  }
}

export const SPONSORSHIP_UNAVAILABLE_MESSAGE = "QC DAO could not cover the network fee for this transaction. Nothing was saved and your entries are still here. Try again in a few minutes; if it keeps failing, tell an administrator that gas sponsorship is unavailable.";
export const SPONSORED_PENDING_MESSAGE = "Your wallet request is still unresolved and may already have been sent. Check its status before trying again, so it is not sent twice.";

export const SPONSORED_REVERT_MESSAGE = "The transaction reverted on-chain. Nothing was saved; check the record's status before retrying.";

/**
 * viem wraps whatever the provider throws (UnknownRpcError inside a
 * ContractFunctionExecutionError), so these carry `walletOutcome` for
 * walletOutcomeError() in errors.js to find through the cause chain.
 */
export class SponsorshipUnavailableError extends Error {
  constructor(cause) {
    super(SPONSORSHIP_UNAVAILABLE_MESSAGE, { cause });
    this.name = "SponsorshipUnavailableError";
    this.walletOutcome = "sponsorship-unavailable";
  }
}

/**
 * `wallet`: { address, chainId, switchChain(id), getEthereumProvider(),
 * sendSponsoredTransaction(tx) } or null.
 */
export function setActiveEmbeddedWallet(wallet) {
  active = wallet?.address ? wallet : null;
}

export function getActiveEmbeddedWallet() {
  return active;
}

const same = (left, right) => Boolean(left && right && String(left).toLowerCase() === String(right).toLowerCase());
const TX_HASH = /^0x[0-9a-f]{64}$/i;
const USER_OPERATION_EVENT = parseAbiItem("event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)");
const FIND_TIMEOUT_MS = 120_000;
const FIND_INTERVAL_MS = 1_500;
const SCAN_PAGE_BLOCKS = 1_000n;
const SCAN_OVERLAP_BLOCKS = 2n;
const MAX_SCAN_PAGES = 8;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PENDING_PREFIX = `qcdao:privy-pending:${arbitrumSepolia.id}:`;
const pendingSends = new Map();
const pendingListeners = new Set();
const pendingKey = (address) => `${PENDING_PREFIX}${String(address).toLowerCase()}`;
const notifyPending = () => {
  for (const listener of pendingListeners) {
    try { listener(); } catch { /* Observers must not interrupt transaction recovery. */ }
  }
};
const unreadablePending = (address, key) => Object.freeze({
  ...(pendingSends.get(key) ?? { id: "unreadable", address, phase: "unresolved", chainId: arbitrumSepolia.id }),
});

/** A submitted operation survives reloads; recovery never signs or sends again. */
export function getPendingSponsoredTransaction(address) {
  if (!address) return null;
  const key = pendingKey(address);
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) { pendingSends.delete(key); return null; }
      const stored = JSON.parse(raw);
      if (stored?.id && same(stored.address, address) && stored.chainId === arbitrumSepolia.id
        && /^\d+$/.test(stored.fromBlock ?? "") && stored.to && typeof stored.data === "string"
        && /^\d+$/.test(stored.value ?? "")) {
        const current = pendingSends.get(key);
        const currentCursor = /^\d+$/.test(current?.scanFromBlock ?? "") ? BigInt(current.scanFromBlock) : 0n;
        const storedCursor = /^\d+$/.test(stored.scanFromBlock ?? "") ? BigInt(stored.scanFromBlock) : BigInt(stored.fromBlock);
        const pending = current?.id === stored.id && !stored.transactionHash
          && (current.transactionHash || currentCursor > storedCursor) ? current : stored;
        pendingSends.set(key, pending);
        return Object.freeze({ ...pending });
      }
      // An unreadable pending record cannot prove that no transaction was sent.
      return unreadablePending(address, key);
    } catch {
      // A failed read or malformed JSON is uncertainty, not absence. Do not
      // overwrite a potentially submitted operation with a new wallet request.
      return unreadablePending(address, key);
    }
  }
  const pending = pendingSends.get(key);
  return pending ? Object.freeze({ ...pending }) : null;
}

function savePending(pending, { beforeBroadcast = false } = {}) {
  const key = pendingKey(pending.address);
  if (typeof window !== "undefined") {
    try { window.localStorage.setItem(key, JSON.stringify(pending)); }
    catch {
      if (beforeBroadcast) {
        throw new WalletUnavailableError("This browser could not preserve the pending transaction. Enable site storage, then try again.");
      }
    }
  }
  pendingSends.set(key, pending);
  notifyPending();
}

function clearPending(address) {
  const key = pendingKey(address);
  pendingSends.delete(key);
  try { if (typeof window !== "undefined") window.localStorage.removeItem(key); } catch { /* A stale record can be recovered again safely. */ }
  notifyPending();
}

/**
 * Pending records owned by a send that is still running in this tab. The record
 * is still saved first (so a reload or another tab can recover it), but the
 * global recovery banner is for an earlier or abandoned send, not the action
 * the member is completing right now.
 */
const inFlightSends = new Map();
function claimInFlight(address, id) {
  inFlightSends.set(pendingKey(address), id);
}
function releaseInFlight(address, id) {
  const key = pendingKey(address);
  if (inFlightSends.get(key) !== id) return;
  inFlightSends.delete(key);
  notifyPending();
}
export function isSponsoredTransactionInFlight(address, id) {
  return Boolean(address && id && inFlightSends.get(pendingKey(address)) === id);
}

export function subscribePendingSponsoredTransactions(listener) {
  pendingListeners.add(listener);
  const onStorage = (event) => { if (!event.key || event.key.startsWith(PENDING_PREFIX)) listener(); };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    pendingListeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

function pendingError(pending, cause) {
  return Object.assign(new Error(SPONSORED_PENDING_MESSAGE, { cause }), {
    walletOutcome: "pending",
    ...(TX_HASH.test(pending?.transactionHash ?? "") ? { transactionHash: pending.transactionHash } : {}),
    pendingSponsoredTransaction: Object.freeze({ ...pending }),
  });
}

const sameRequest = (pending, request) => same(pending.to, request.to)
  && pending.data.toLowerCase() === String(request.data ?? "0x").toLowerCase()
  && pending.value === BigInt(request.value ?? 0n).toString();

function definiteSponsorshipRefusal(error) {
  return /gas sponsorship (?:is )?(?:not enabled|disabled)|(?:unsupported|not supported) (?:chain|network)|sponsorship (?:policy|limit|budget).*(?:denied|rejected|exceeded)/i
    .test(String(error?.message ?? error));
}

function isRejection(error) {
  for (let current = error, depth = 0; current && depth < 6; current = current.cause, depth++) {
    if (["4001", "ACTION_REJECTED"].includes(String(current.code ?? ""))) return true;
    if (/user (?:rejected|denied|cancelled|canceled|exited)|UserRejectedRequestError/i.test(`${current.name ?? ""} ${current.message ?? ""}`)) return true;
  }
  return false;
}

/**
 * One sponsored send per wallet. A second action waits, so this tab cannot
 * attribute another in-flight operation to the action that is still open.
 */
const sendQueues = new Map();

function enqueueSend(address, task) {
  const key = String(address).toLowerCase();
  const previous = sendQueues.get(key) ?? Promise.resolve();
  // Web Locks also serialize tabs sharing the same embedded wallet. The saved
  // pending record is checked inside the lock, before another prompt opens.
  const lockedTask = () => typeof navigator !== "undefined" && navigator.locks?.request
    ? navigator.locks.request(pendingKey(address), task) : task();
  const run = previous.then(lockedTask, lockedTask);
  // The queue must not reject on its own. The caller handles `run`.
  const settled = run.then(() => {}, () => {});
  settled.finally(() => {
    if (sendQueues.get(key) === settled) sendQueues.delete(key);
  });
  sendQueues.set(key, settled);
  return run;
}

const sameCall = (call, { to, data, value }) => {
  if (!call?.sponsored || !same(call.to, to)) return false;
  const wanted = (data ?? "0x").toLowerCase();
  if (String(call.input ?? "0x").toLowerCase() !== wanted) return false;
  const wantedValue = value === undefined || value === null ? 0n : BigInt(value);
  return (call.value ?? 0n) === wantedValue;
};

/**
 * Privy reports a paymaster-sponsored transaction's hash as "" until it is
 * mined. Match the EntryPoint log whose user operation carries this exact
 * call, not merely the first operation from the same wallet.
 */
async function findSponsoredTransaction({ publicClient, pending, timeoutMs = FIND_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  const fromBlock = BigInt(pending.fromBlock);
  let cursor = /^\d+$/.test(pending.scanFromBlock ?? "") ? BigInt(pending.scanFromBlock) : fromBlock;
  if (cursor < fromBlock) cursor = fromBlock;
  let tip = null;
  let pages = 0;
  while (Date.now() < deadline) {
    try {
      if (tip === null) tip = await publicClient.getBlockNumber({ cacheTime: 0 });
      if (cursor <= tip) {
        if (pages >= MAX_SCAN_PAGES || Date.now() >= deadline) break;
        const pageEnd = cursor + SCAN_PAGE_BLOCKS - 1n < tip ? cursor + SCAN_PAGE_BLOCKS - 1n : tip;
        pages++;
        const logs = await publicClient.getLogs({ address: [...ENTRY_POINTS], event: USER_OPERATION_EVENT,
          args: { sender: pending.address }, fromBlock: cursor, toBlock: pageEnd });
        const ordered = [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
        for (const log of ordered) {
          if (!TX_HASH.test(log.transactionHash ?? "") || typeof log.blockNumber !== "bigint"
            || log.blockNumber < cursor || log.blockNumber > pageEnd || log.blockNumber < fromBlock) continue;
          if (Date.now() >= deadline) throw pendingError(pending);
          // Do not advance the page cursor if a candidate transaction could not
          // be read. That candidate may be the operation we need to recover.
          const transaction = await publicClient.getTransaction({ hash: log.transactionHash });
          if (!transaction) throw new Error("The pending operation's transaction is not available yet.");
          const call = decodeMemberCall(transaction, { sender: pending.address });
          if (sameCall(call, pending)) return { hash: log.transactionHash, nonce: call.nonce, pending };
        }
        cursor = pageEnd + 1n - SCAN_OVERLAP_BLOCKS;
        if (cursor < fromBlock) cursor = fromBlock;
        pending = { ...pending, scanFromBlock: cursor.toString() };
        savePending(pending);
        if (pageEnd < tip) continue;
      }
    } catch (error) {
      throw pendingError(pending, error);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await wait(Math.min(FIND_INTERVAL_MS, remaining));
    tip = null;
  }
  throw pendingError(pending);
}

/**
 * Sends one transaction with Privy gas sponsorship (QCDAO-144) and resolves
 * with its hash once the member's call has actually run. A sponsored call can
 * fail inside a mined transaction, so the EntryPoint's own outcome is checked
 * and a failure is reported as a revert, never as success.
 */
export async function sendSponsoredTransaction(request, { wallet = active, publicClient = browserPublicClient, timeoutMs } = {}) {
  if (!wallet?.sendSponsoredTransaction) throw new WalletUnavailableError();
  if (request.from && !same(request.from, wallet.address)) {
    throw new WalletUnavailableError("This action belongs to a different account from the one signed in. Sign in with that account's email, then try again.");
  }
  return enqueueSend(wallet.address, () => submitSponsoredTransaction(request, { wallet, publicClient, timeoutMs }));
}

async function submitSponsoredTransaction(request, { wallet, publicClient, timeoutMs }) {
  const existing = getPendingSponsoredTransaction(wallet.address);
  if (existing) {
    if (!existing.to || !sameRequest(existing, request)) throw pendingError(existing);
    // The member repeated the same call: this action now owns that recovery.
    claimInFlight(wallet.address, existing.id);
    try { return await recoverStoredTransaction(existing, { publicClient, timeoutMs }); }
    finally { releaseInFlight(wallet.address, existing.id); }
  }
  // Never identify the new operation with an identical call already mined at
  // the observed tip. Disable viem's block-number cache before taking this boundary.
  const fromBlock = (await publicClient.getBlockNumber({ cacheTime: 0 })) + 1n;
  let pending = {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    address: wallet.address, to: request.to, data: request.data ?? "0x",
    value: BigInt(request.value ?? 0n).toString(), chainId: arbitrumSepolia.id,
    fromBlock: fromBlock.toString(), scanFromBlock: fromBlock.toString(), phase: "sending", createdAt: Date.now(),
  };
  // Claimed before the record is saved so observers never see it as orphaned;
  // released (with a notification) when this send settles, fails or is abandoned.
  claimInFlight(wallet.address, pending.id);
  try {
    savePending(pending, { beforeBroadcast: true });
    return await broadcastSponsoredTransaction(pending, request, { wallet, publicClient, timeoutMs });
  } finally { releaseInFlight(wallet.address, pending.id); }
}

async function broadcastSponsoredTransaction(pending, request, { wallet, publicClient, timeoutMs }) {
  let result;
  try {
    result = await wallet.sendSponsoredTransaction({
      to: request.to,
      data: request.data,
      // viem hands the provider hex quantities; Privy expects numbers.
      ...(request.value !== undefined && BigInt(request.value) !== 0n ? { value: BigInt(request.value) } : {}),
      chainId: arbitrumSepolia.id,
    });
  } catch (error) {
    if (isRejection(error) || error instanceof WalletUnavailableError || definiteSponsorshipRefusal(error)) {
      clearPending(wallet.address);
      if (isRejection(error) || error instanceof WalletUnavailableError) throw error;
      throw new SponsorshipUnavailableError(error);
    }
    // A network failure after the wallet request may occur after broadcast.
    // Preserve the operation and recover it; a second click must not resend it.
    pending = { ...pending, phase: "unresolved" };
    savePending(pending);
    throw pendingError(pending, error);
  }
  pending = { ...pending, phase: "submitted", ...(TX_HASH.test(result?.hash ?? "") ? { transactionHash: result.hash } : {}) };
  savePending(pending);
  return recoverStoredTransaction(pending, { publicClient, timeoutMs });
}

async function recoverStoredTransaction(pending, { publicClient, timeoutMs }) {
  if (!pending.to || !pending.fromBlock) throw pendingError(pending);
  let hash = pending.transactionHash;
  let nonce = pending.nonce === undefined ? undefined : BigInt(pending.nonce);
  try {
    if (!TX_HASH.test(hash ?? "")) {
      const found = await findSponsoredTransaction({ publicClient, pending, timeoutMs });
      hash = found.hash;
      nonce = found.nonce;
      pending = { ...found.pending, phase: "submitted", transactionHash: hash, nonce: nonce.toString() };
      savePending(pending);
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash, ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) });
    const succeeded = userOperationSucceeded(receipt, pending.address, nonce !== undefined ? { nonce } : {});
    if (receipt.status !== "success" || succeeded === false) {
      clearPending(pending.address);
      throw Object.assign(new Error(SPONSORED_REVERT_MESSAGE), {
        walletOutcome: "reverted", transactionHash: hash, transactionSettled: true,
      });
    }
    clearPending(pending.address);
    return hash;
  } catch (error) {
    if (error.walletOutcome === "reverted" || error.walletOutcome === "pending") throw error;
    throw pendingError(pending, error);
  }
}

/** Checks the saved operation only. This function never asks Privy to send. */
export function recoverPendingSponsoredTransaction({ wallet = active, publicClient = browserPublicClient, timeoutMs } = {}) {
  if (!wallet?.address) return Promise.reject(new WalletUnavailableError());
  return enqueueSend(wallet.address, () => {
    const pending = getPendingSponsoredTransaction(wallet.address);
    return pending ? recoverStoredTransaction(pending, { publicClient, timeoutMs }) : null;
  });
}

/**
 * The embedded wallet's EIP-1193 provider with transaction sending routed
 * through sendSponsoredTransaction. Everything else (chain id, accounts,
 * reads) goes to Privy's provider unchanged.
 */
export function sponsoredProvider(provider, options) {
  return {
    request: async (args) => {
      if (args?.method === "eth_sendTransaction" || args?.method === "wallet_sendTransaction") {
        return sendSponsoredTransaction(args.params?.[0] ?? {}, options);
      }
      return provider.request(args);
    },
  };
}

/**
 * A viem wallet client for `account` on Arbitrum Sepolia, or a clear refusal.
 * Embedded wallets switch networks silently, so there is no network prompt for
 * a member to decline - the switch simply happens before signing. Members
 * never pay gas: every transaction is sponsored through Privy.
 */
export async function embeddedWalletClient({ account, chainId = arbitrumSepolia.id } = {}) {
  const wallet = active;
  if (!wallet) throw new WalletUnavailableError();
  if (account && !same(account, wallet.address)) {
    throw new WalletUnavailableError(
      "This action belongs to a different account from the one signed in. Sign in with that account's email, then try again.",
    );
  }
  if (Number(chainId) !== arbitrumSepolia.id) {
    throw new Error(`QC DAO only signs transactions on ${arbitrumSepolia.name}.`);
  }
  if (wallet.chainId !== arbitrumSepolia.id) await wallet.switchChain(arbitrumSepolia.id);
  // Requested after any switch: Privy does not update provider instances it
  // handed out before the chain changed.
  const provider = await wallet.getEthereumProvider();
  return createWalletClient({ account: wallet.address, chain: arbitrumSepolia, transport: custom(sponsoredProvider(provider, { wallet })) });
}
