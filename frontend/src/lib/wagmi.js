import { createConfig, http } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";

/**
 * No connectors are declared here on purpose.
 *
 * wagmi v3 enables `multiInjectedProviderDiscovery` by default, so every browser
 * wallet that implements EIP-6963 — MetaMask, Coinbase Wallet, Rabby, Brave,
 * Phantom — announces itself and appears in the picker automatically, each with its
 * own name and icon.
 *
 * The explicit `injected()`, `metaMask()` and `coinbaseWallet()` connectors were
 * removed because they were worse than redundant:
 *
 *   - `injected()` is a generic catch-all. With EIP-6963 discovery it duplicated
 *     every real wallet under a meaningless "Injected" label, and on a machine with
 *     no extension it failed at connect time with "Provider not found".
 *   - `metaMask()` and `coinbaseWallet()` need `@metamask/connect-evm` and
 *     `@coinbase/wallet-sdk`, which wagmi declares as OPTIONAL peer dependencies and
 *     does not install. Without them the build cannot resolve the import.
 *
 * To add WalletConnect (QR sign-in from a phone) you would need:
 *     npm install @walletconnect/ethereum-provider
 * Be aware that today it pulls in @reown/appkit -> @base-org/account -> axios, which
 * carries a high-severity advisory, and adds substantially to the bundle. It is left
 * out until that is worth paying for.
 */
export const wagmiConfig = createConfig({
  chains: [arbitrumSepolia],
  transports: {
    [arbitrumSepolia.id]: http(
      import.meta.env.VITE_ARBITRUM_SEPOLIA_RPC_URL?.trim() || undefined,
    ),
  },
});

/**
 * Wallets that announce over EIP-6963 but cannot actually sign for an EVM chain like
 * Arbitrum Sepolia. Keplr is Cosmos-native and would fail at the signature step, so
 * offering it is a dead end. Matched on EIP-6963 rdns (which wagmi uses as the
 * connector id) and on name as a fallback.
 */
const NON_EVM_WALLETS = {
  ids: new Set(["app.keplr", "io.leapwallet.leap", "app.leapwallet"]),
  names: new Set(["keplr", "leap", "leap wallet", "cosmostation"]),
};

export function isUsableConnector(connector) {
  const id = String(connector.id ?? "").toLowerCase();
  const name = String(connector.name ?? "").trim().toLowerCase();
  if (NON_EVM_WALLETS.ids.has(id)) return false;
  if (NON_EVM_WALLETS.names.has(name)) return false;
  // Belt and braces: the generic injected connector should no longer exist, but if
  // one is reintroduced it must not resurface as a nameless "Injected" row.
  if (id === "injected" || name === "injected") return false;
  return true;
}

export { arbitrumSepolia };
