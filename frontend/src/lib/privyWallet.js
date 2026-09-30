import { createWalletClient, custom, getAddress } from "viem";

export class PrivyWalletNotReadyError extends Error {
  constructor() {
    super("Privy did not connect a wallet that can sign. Try again.");
    this.name = "PrivyWalletNotReadyError";
  }
}

let ensureImpl = async () => {};
let signImpl = null;

/** Registered while PrivyProvider is mounted. */
export function registerPrivyWallet(ensure) {
  ensureImpl = typeof ensure === "function" ? ensure : async () => {};
}

export function ensurePrivyWallet(address) {
  return ensureImpl(address);
}

/** Returns null when Privy is not mounted. */
export function registerSignPrivyMessage(sign) {
  signImpl = typeof sign === "function" ? sign : null;
}

export function signPrivyMessage(address, message) {
  if (!signImpl) return null;
  return signImpl(address, message);
}

export async function signWithEthereumProvider({ provider, address, message, chain }) {
  const client = createWalletClient({
    account: getAddress(address),
    chain,
    transport: custom(provider),
  });
  return client.signMessage({ message });
}

/**
 * Attach the Privy wallet. `connectWallet` returns false while the wallet
 * provider is still starting.
 */
export async function waitForPrivyWallet({
  address,
  wallets,
  connectWallet,
  isConnected,
  timeoutMs = 10000,
  intervalMs = 50,
  retryMs = 300,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const wanted = address.toLowerCase();
  const deadline = Date.now() + timeoutMs;
  let lastAttempt = 0;
  let lastError = null;

  while (Date.now() < deadline) {
    if (isConnected(wanted)) return;
    const now = Date.now();
    const wallet = wallets().find((item) => item?.address?.toLowerCase() === wanted);
    if (wallet && now - lastAttempt >= retryMs) {
      lastAttempt = now;
      try {
        await connectWallet(wallet);
        if (isConnected(wanted)) return;
      } catch (error) {
        if (error?.name === "UserRejectedRequestError" || error?.code === 4001) throw error;
        lastError = error;
      }
    }
    await sleep(intervalMs);
  }

  throw lastError ?? new PrivyWalletNotReadyError();
}
