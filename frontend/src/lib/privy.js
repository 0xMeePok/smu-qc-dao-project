import { arbitrumSepolia } from "viem/chains";

/** Public app id from the Privy dashboard. The app secret stays on Privy's side. */
export const privyAppId = import.meta.env?.VITE_PRIVY_APP_ID?.trim() || "";

export const privyConfig = {
  loginMethods: ["email", "wallet"],
  defaultChain: arbitrumSepolia,
  supportedChains: [arbitrumSepolia],
  appearance: {
    showWalletLoginFirst: false,
    accentColor: "#d23a16",
  },
  embeddedWallets: {
    ethereum: {
      createOnLogin: "users-without-wallets",
    },
  },
};

export function ethereumAddressFromPrivyUser(user) {
  const accounts = user?.linkedAccounts ?? [];
  const ethereum = accounts.find((account) => account?.type === "wallet" && account?.chainType !== "solana" && account?.address);
  return ethereum?.address ?? user?.wallet?.address ?? null;
}
