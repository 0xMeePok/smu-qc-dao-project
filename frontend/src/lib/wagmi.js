import { createConfig, http } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";

/**
 * No connectors are declared here. wagmi v3 enables `multiInjectedProviderDiscovery`
 * by default, so every EIP-6963 wallet installed in the browser announces itself
 * automatically - `isUsableConnector` below is what narrows that down to just
 * MetaMask and Rabby.
 */
export const wagmiConfig = createConfig({
  chains: [arbitrumSepolia],
  transports: {
    [arbitrumSepolia.id]: http(
      import.meta.env?.VITE_ARBITRUM_SEPOLIA_RPC_URL?.trim() || undefined,
    ),
  },
});

// wagmi sets an EIP-6963-discovered connector's `id` to the wallet's own `rdns`
// string (confirmed in @wagmi/core/createConfig.js: `id: info.rdns`), which is why
// this matches on `id` rather than the free-text `name`. Values confirmed directly
// from each wallet's own source, not guessed: MetaMask's rabbykit connector
// (RabbyHub/rabbykit .../metaMaskWallet.ts) declares `rdns: "io.metamask"`, and
// Rabby's own connector in the same repo (.../rabbyWallet.ts) declares
// `rdns: "io.rabby"`.
const ALLOWED_WALLET_IDS = new Set(["io.metamask", "io.rabby"]);

export function isUsableConnector(connector) {
  return ALLOWED_WALLET_IDS.has(String(connector.id ?? "").toLowerCase());
}

export { arbitrumSepolia };
