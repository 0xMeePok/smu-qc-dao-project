import { arbitrumSepolia } from "viem/chains";

/**
 * Privy is the only way into the app: Privy's own login modal, limited to email
 * and a one-time code, and the embedded wallet Privy creates for that email on
 * its first sign-in. The account is still the wallet address. The server reads
 * that wallet from Privy when it mints the Firebase session (see lib/authFlow.js).
 *
 * The app id is public and ships in every bundle. The app secret never reaches
 * the browser.
 */
const viteEnv = import.meta.env ?? {};
export const privyAppId = viteEnv.VITE_PRIVY_APP_ID?.trim() ?? "";
export const isPrivyConfigured = privyAppId.length > 0;

export const PRIVY_NOT_CONFIGURED_MESSAGE =
  "Email sign-in is not configured. Add VITE_PRIVY_APP_ID to frontend/.env.local (or frontend/.env) and restart the dev server.";

/** The only login method Privy's modal may offer. */
export const LOGIN_METHODS = Object.freeze(["email"]);

/** Wallet client types Privy reports for wallets it created inside the app. */
export const EMBEDDED_WALLET_CLIENT_TYPES = Object.freeze(["privy", "privy-v2"]);

const isEmbeddedType = (walletClientType) => EMBEDDED_WALLET_CLIENT_TYPES.includes(walletClientType);

export const privyConfig = {
  loginMethods: [...LOGIN_METHODS],
  defaultChain: arbitrumSepolia,
  supportedChains: [arbitrumSepolia],
  appearance: {
    // Served from this origin, so the modal's logo needs no CSP img-src change
    // (a logo uploaded in the Privy dashboard would come from Privy's CDN).
    logo: "/favicon.svg",
    landingHeader: "Sign in to QC DAO",
    loginMessage: "Use your email address. There is no wallet to install.",
    accentColor: "#d23a16",
    showWalletLoginFirst: false,
    // Privy's default list names MetaMask, Rainbow, WalletConnect and others,
    // and fetching their listings is all it would do here. Empty: no wallet
    // is ever offered, and the WalletConnect registry is never contacted.
    walletList: [],
  },
  embeddedWallets: {
    ethereum: {
      // Privy's login modal creates the wallet on a member's first sign-in.
      createOnLogin: "users-without-wallets",
    },
  },
  // No browser-extension or WalletConnect wallets: the embedded wallet is the
  // only wallet this app will ever see, connect to or sign with.
  externalWallets: {
    disableAllExternalWallets: true,
    walletConnect: { enabled: false },
  },
};

/** The user's Privy-created Ethereum wallet, as linked to their Privy account. */
export function linkedEmbeddedWallet(user) {
  return user?.linkedAccounts?.find((account) => account?.type === "wallet"
    && account.chainType === "ethereum"
    && isEmbeddedType(account.walletClientType)
    && account.address) ?? null;
}

/**
 * The same wallet once Privy has loaded its signer. External wallets are never
 * returned, even if a browser extension somehow reports one as connected.
 */
export function connectedEmbeddedWallet(wallets, address) {
  return wallets?.find((wallet) => wallet?.type === "ethereum"
    && isEmbeddedType(wallet.walletClientType)
    && wallet.address
    && (!address || wallet.address.toLowerCase() === address.toLowerCase())) ?? null;
}

/** Privy reports chains as CAIP-2 ("eip155:421614"); everything else here uses numbers. */
export function chainIdOf(wallet) {
  const raw = wallet?.chainId;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  const match = /^(?:eip155:)?(0x[0-9a-f]+|\d+)$/i.exec(String(raw ?? ""));
  return match ? Number(match[1]) : undefined;
}
