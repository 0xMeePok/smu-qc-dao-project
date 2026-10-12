import { createWalletClient, custom, parseAbiItem } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { ENTRY_POINTS, userOperationSucceeded } from "../../../firebase/functions/memberCall.js";
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
export const SPONSORED_PENDING_MESSAGE = "Your transaction was sent but has not confirmed yet. Wait a minute and refresh before trying again, so it is not sent twice.";

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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRejection(error) {
  for (let current = error, depth = 0; current && depth < 6; current = current.cause, depth++) {
    if (["4001", "ACTION_REJECTED"].includes(String(current.code ?? ""))) return true;
    if (/user (?:rejected|denied|cancelled|canceled|exited)|UserRejectedRequestError/i.test(`${current.name ?? ""} ${current.message ?? ""}`)) return true;
  }
  return false;
}

/**
 * Privy reports a paymaster-sponsored transaction's hash as "" until it is
 * mined. The EntryPoint logs every operation with its sender, so the member's
 * transaction is the first one from their wallet after `fromBlock`.
 */
async function findSponsoredTransaction({ publicClient, sender, fromBlock, timeoutMs = FIND_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = await publicClient.getLogs({ address: [...ENTRY_POINTS], event: USER_OPERATION_EVENT, args: { sender }, fromBlock })
      .catch(() => []);
    const first = logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))[0];
    if (first?.transactionHash) return first.transactionHash;
    await wait(FIND_INTERVAL_MS);
  }
  throw Object.assign(new Error(SPONSORED_PENDING_MESSAGE), { walletOutcome: "pending" });
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
  const fromBlock = await publicClient.getBlockNumber();
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
    if (isRejection(error) || error instanceof WalletUnavailableError) throw error;
    throw new SponsorshipUnavailableError(error);
  }
  const hash = TX_HASH.test(result?.hash ?? "")
    ? result.hash
    : await findSponsoredTransaction({ publicClient, sender: wallet.address, fromBlock, timeoutMs });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const succeeded = userOperationSucceeded(receipt, wallet.address);
  if (receipt.status !== "success" || succeeded === false) {
    throw Object.assign(new Error(SPONSORED_REVERT_MESSAGE), { walletOutcome: "reverted", transactionHash: hash });
  }
  return hash;
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
