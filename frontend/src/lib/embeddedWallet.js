import { createWalletClient, custom } from "viem";
import { arbitrumSepolia } from "viem/chains";

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

/** `wallet`: { address, chainId, switchChain(id), getEthereumProvider() } or null. */
export function setActiveEmbeddedWallet(wallet) {
  active = wallet?.address ? wallet : null;
}

export function getActiveEmbeddedWallet() {
  return active;
}

const same = (left, right) => Boolean(left && right && String(left).toLowerCase() === String(right).toLowerCase());

/**
 * A viem wallet client for `account` on Arbitrum Sepolia, or a clear refusal.
 * Embedded wallets switch networks silently, so there is no network prompt for
 * a member to decline - the switch simply happens before signing.
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
  return createWalletClient({ account: wallet.address, chain: arbitrumSepolia, transport: custom(provider) });
}
