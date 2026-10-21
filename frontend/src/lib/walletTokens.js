import { erc20Abi, getAddress, isAddress, parseEventLogs, parseUnits, zeroAddress } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { AUDIT_REGISTRY_CONFIG } from "../config/auditRegistry.js";
import { embeddedWalletClient } from "./embeddedWallet.js";
import { createWalletAuditAdapters, normalizeWalletWriteError, waitForAuditReceipt } from "./auditRegistry.js";
import { browserPublicClient } from "./rpc.js";

export const WALLET_TOKENS = Object.freeze(AUDIT_REGISTRY_CONFIG.escrow.tokens.map(token => Object.freeze({
  symbol: token.symbol, address: getAddress(token.address), decimals: token.decimals,
})));
const MAX_AMOUNT = (1n << 256n) - 1n;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const same = (left, right) => left.toLowerCase() === right.toLowerCase();
const transfersInFlight = new Set();

function supportedToken(value) {
  const symbol = typeof value === "string" ? value : value?.symbol;
  const token = WALLET_TOKENS.find(item => item.symbol === symbol);
  if (!token || (value?.address && !same(value.address, token.address))) {
    throw new Error("Choose a supported test token: XSGD, USDT or USDC.");
  }
  return token;
}

function walletAddress(value, label) {
  if (typeof value !== "string" || !isAddress(value) || same(value, zeroAddress)) {
    throw new Error(`Enter a valid ${label} wallet address.`);
  }
  return getAddress(value);
}

function transferDetails({ token: selected, amount, recipient, address }) {
  const token = supportedToken(selected);
  const sender = walletAddress(address, "sending");
  const to = walletAddress(recipient, "recipient");
  if (same(sender, to)) throw new Error("Choose a recipient other than your own wallet.");
  if (typeof amount !== "bigint" || amount <= 0n || amount > MAX_AMOUNT) throw new Error("Enter an amount greater than 0 within the token's supported range.");
  return { token, amount, recipient: to, address: sender };
}

/** Exact display validation; sendWalletTokens checks the live balance again. */
export function validateTokenTransfer({ token: selected, amount, recipient, address, balance }) {
  const token = supportedToken(selected);
  const text = typeof amount === "string" ? amount.trim() : "";
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw new Error(`Enter an amount with at most ${token.decimals} decimal places.`);
  const details = transferDetails({ token, amount: parseUnits(text, token.decimals), recipient, address });
  if (typeof balance !== "bigint" || balance < 0n) throw new Error("Refresh your wallet balance before sending.");
  if (details.amount > balance) throw new Error(`Your ${token.symbol} balance is too low for this transfer.`);
  return { token, amount: details.amount, recipient: details.recipient };
}

export async function readWalletBalances(address, { publicClient = browserPublicClient } = {}) {
  const account = walletAddress(address, "connected");
  const balances = await Promise.all(WALLET_TOKENS.map(async token => {
    const balance = await publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [account] });
    if (typeof balance !== "bigint" || balance < 0n) throw new Error("The wallet balance could not be confirmed. Refresh and try again.");
    return [token.symbol, balance];
  }));
  return Object.fromEntries(balances);
}

function notifySubmitted(callback, transactionHash) {
  try { Promise.resolve(callback?.({ transactionHash })).catch(() => {}); }
  catch { /* UI observers cannot change a broadcast transaction's outcome. */ }
}

function pendingTransfer(error, transactionHash) {
  const pending = new Error("Your transfer was submitted, but its confirmation is still pending. Check its status before sending again.", { cause: error });
  pending.walletOutcome = "pending";
  pending.transactionHash = transactionHash;
  return pending;
}

/** Polls one known hash only; it never asks the wallet to sign or send again. */
export async function confirmWalletTokenTransfer(input, { publicClient = browserPublicClient } = {}) {
  const details = transferDetails(input);
  const transactionHash = input.transactionHash;
  if (!HASH.test(transactionHash ?? "")) throw new Error("The transfer transaction hash is invalid.");
  let receipt;
  try {
    receipt = await waitForAuditReceipt({ transactionHash,
      adapters: createWalletAuditAdapters({ publicClient }),
      confirmations: 2, timeout: 120_000, maxRetries: 0,
    });
  } catch (error) {
    if (error.code === "AUDIT_TRANSACTION_CANCELLED") {
      throw Object.assign(new Error("The transfer was cancelled. No tokens were sent by this request.", { cause: error }), {
        walletOutcome: "reverted", transactionHash, terminal: true, transactionSettled: true,
      });
    }
    throw pendingTransfer(error, transactionHash);
  }
  if (!receipt || !["success", "reverted"].includes(receipt.status)) throw pendingTransfer(new Error("The receipt could not be confirmed."), transactionHash);
  if (receipt.status === "reverted") {
    throw Object.assign(new Error("The transfer reverted on-chain. No tokens were sent by this request."), {
      walletOutcome: "reverted", transactionHash, terminal: true, transactionSettled: true,
    });
  }
  const transfer = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs ?? [], strict: true })
    .find(log => same(log.address, details.token.address) && same(log.args.from, details.address)
      && same(log.args.to, details.recipient) && log.args.value === details.amount);
  if (!transfer) {
    throw Object.assign(new Error("The confirmed transaction does not contain this token transfer. Refresh the wallet before trying again."), {
      walletOutcome: "reverted", transactionHash, terminal: true, transactionSettled: true,
    });
  }
  return { ...details, transactionHash: receipt.transactionHash ?? transactionHash, receipt };
}

/** One explicit attempt: fresh balance, simulation, sponsored signature, confirmation. */
export async function sendWalletTokens(input, dependencies = {}) {
  const details = transferDetails(input);
  const key = details.address.toLowerCase();
  if (transfersInFlight.has(key)) throw new Error("A wallet transfer is already in progress. Wait for its result before sending again.");
  transfersInFlight.add(key);
  try { return await submitWalletTokens(input, details, dependencies); }
  finally { transfersInFlight.delete(key); }
}

async function submitWalletTokens(input, details, { publicClient = browserPublicClient, walletClient = embeddedWalletClient }) {
  const { token, amount, recipient, address } = details;
  const balance = await publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  if (typeof balance !== "bigint" || balance < amount) throw new Error(`Your ${token.symbol} balance is too low for this transfer. Refresh your wallet.`);
  const request = { address: token.address, abi: erc20Abi, functionName: "transfer", args: [recipient, amount], account: address };
  const simulation = await publicClient.simulateContract(request);
  if (simulation.result === false) throw new Error("The token refused this transfer. No wallet request was sent.");
  const wallet = await walletClient({ account: address, chainId: arbitrumSepolia.id, onSubmitted: input.onSubmitted });
  let transactionHash;
  try { transactionHash = await wallet.writeContract({ ...request, chain: arbitrumSepolia }); }
  catch (error) { throw normalizeWalletWriteError(error); }
  if (!HASH.test(transactionHash ?? "")) throw pendingTransfer(new Error("The wallet did not return a valid transfer transaction hash."));
  notifySubmitted(input.onSubmitted, transactionHash);
  return confirmWalletTokenTransfer({ ...details, transactionHash }, { publicClient });
}

export function createFaucetClaim({ token: selected, address, issuedAt = Math.floor(Date.now() / 1000) }) {
  const token = supportedToken(selected);
  const recipient = walletAddress(address, "connected");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("The mint request timestamp is invalid.");
  return { token: token.symbol, recipient, issuedAt,
    message: ["TAP Faucet Mint", `Token: ${token.symbol}`, `Recipient: ${recipient}`, `Chain ID: ${arbitrumSepolia.id}`, `Issued At: ${issuedAt}`].join("\n") };
}
