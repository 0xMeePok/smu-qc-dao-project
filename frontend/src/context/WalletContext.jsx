import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { useCreateWallet, useLogin, usePrivy, useSignMessage, useWallets } from "@privy-io/react-auth";
import { EXPECTED_CHAIN_ID } from "../lib/chain.js";
import { setActiveEmbeddedWallet, WalletUnavailableError } from "../lib/embeddedWallet.js";
import { SIGN_IN_CANCELLED } from "../lib/errors.js";
import {
  chainIdOf,
  connectedEmbeddedWallet,
  isPrivyConfigured,
  linkedEmbeddedWallet,
  PRIVY_NOT_CONFIGURED_MESSAGE,
} from "../lib/privy.js";

const SIGN_IN_TIMEOUT_MS = 15_000;
const WALLET_TIMEOUT_MS = 30_000;

const notConfigured = () => Promise.reject(new WalletUnavailableError(PRIVY_NOT_CONFIGURED_MESSAGE));

/** Before Privy is configured nobody can sign in, so there is never a wallet. */
export const UNCONFIGURED_WALLET = Object.freeze({
  configured: false,
  ready: true,
  authenticated: false,
  email: null,
  address: null,
  isConnected: false,
  chainId: undefined,
  login: notConfigured,
  ensureWallet: notConfigured,
  signMessage: notConfigured,
  accessToken: notConfigured,
  logout: async () => {},
});

const WalletContext = createContext(UNCONFIGURED_WALLET);

/**
 * The signed-in member's Privy session and embedded wallet. This is the only
 * module that talks to Privy's React hooks, so the rest of the app depends on
 * one small interface rather than on the SDK.
 */
export function useWallet() {
  return useContext(WalletContext);
}

export function WalletProvider({ children }) {
  if (!isPrivyConfigured) {
    return <WalletContext.Provider value={UNCONFIGURED_WALLET}>{children}</WalletContext.Provider>;
  }
  return <PrivyWalletProvider>{children}</PrivyWalletProvider>;
}

function PrivyWalletProvider({ children }) {
  const { ready, authenticated, user, logout, getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();
  const { signMessage: signWithPrivy } = useSignMessage();

  const signedIn = ready && authenticated;
  const linked = signedIn ? linkedEmbeddedWallet(user) : null;
  const wallet = signedIn ? connectedEmbeddedWallet(wallets, linked?.address) : null;
  const chainId = chainIdOf(wallet);
  const address = wallet?.address ?? null;

  // A promise started in one render (login, ensureWallet, signMessage) has to
  // see the state of later ones: Privy's callbacks fire before React re-renders.
  const latest = useRef(null);
  latest.current = { signedIn, user, wallet };
  const waiters = useRef(new Set());
  useEffect(() => {
    for (const waiter of [...waiters.current]) waiter.check();
  });

  const waitFor = useCallback((select, { timeoutMs, message }) => new Promise((resolve, reject) => {
    const waiter = {
      check: () => {
        const value = select(latest.current);
        if (!value) return;
        settle();
        resolve(value);
      },
    };
    const timer = setTimeout(() => {
      settle();
      reject(new WalletUnavailableError(message));
    }, timeoutMs);
    function settle() {
      clearTimeout(timer);
      waiters.current.delete(waiter);
    }
    waiters.current.add(waiter);
    waiter.check();
  }), []);

  // Privy's own login modal does the email, the one-time code and, on a first
  // sign-in, the wallet (privyConfig.embeddedWallets.ethereum.createOnLogin).
  // Its errors - a mistyped code, a bad address - are shown in the modal, which
  // stays open for another try, so only a finished login or a closed modal ends
  // the wait.
  const pendingLogin = useRef(null);
  const settleLogin = (outcome) => {
    const pending = pendingLogin.current;
    pendingLogin.current = null;
    pending?.[outcome.ok ? "resolve" : "reject"](outcome.error);
  };
  const { login: openLoginModal } = useLogin({
    onComplete: () => settleLogin({ ok: true }),
    onError: (code) => {
      if (code !== SIGN_IN_CANCELLED) return;
      settleLogin({ ok: false, error: Object.assign(new Error("Sign-in was cancelled."), { privyErrorCode: code }) });
    },
  });

  /** Opens Privy's login modal; resolves once the member has signed in with it. */
  const login = useCallback(() => {
    // Privy ignores login() for a session it already has, so there is nothing to open.
    if (latest.current.signedIn) return Promise.resolve();
    if (!ready) {
      return Promise.reject(new WalletUnavailableError("Email sign-in is still loading. Try again in a moment."));
    }
    if (!pendingLogin.current) {
      const pending = {};
      pending.promise = new Promise((resolve, reject) => Object.assign(pending, { resolve, reject }));
      pendingLogin.current = pending;
      openLoginModal();
    }
    return pendingLogin.current.promise;
  }, [ready, openLoginModal]);

  // Embedded wallets start on the default chain. If one is ever elsewhere, move
  // it back silently; the transaction adapter re-checks before signing anyway.
  const switching = useRef(null);
  useEffect(() => {
    if (!wallet || chainId === EXPECTED_CHAIN_ID || switching.current === wallet.address) return;
    switching.current = wallet.address;
    wallet.switchChain(EXPECTED_CHAIN_ID)
      .catch(() => {})
      .finally(() => { switching.current = null; });
  }, [wallet, chainId]);

  // The audit and escrow adapters run outside React; publish the wallet to them.
  useEffect(() => {
    setActiveEmbeddedWallet(wallet ? {
      address: wallet.address,
      chainId,
      switchChain: (id) => wallet.switchChain(id),
      getEthereumProvider: () => wallet.getEthereumProvider(),
    } : null);
    return () => setActiveEmbeddedWallet(null);
  }, [wallet, chainId]);

  /**
   * Resolves to the embedded wallet address once its signer has loaded. Privy's
   * modal creates the wallet on a first sign-in; creating it here covers an
   * account that still has none (that step failed, or it was interrupted).
   */
  const ensureWallet = useCallback(async () => {
    const session = await waitFor((state) => state.signedIn && state, {
      timeoutMs: SIGN_IN_TIMEOUT_MS,
      message: "Email sign-in did not finish. Try again.",
    });
    if (!session.wallet && !linkedEmbeddedWallet(session.user)) {
      try {
        await createWallet();
      } catch (error) {
        // Already created moments ago - by another tab, or by Privy's modal.
        // It loads below like any existing wallet.
        if (!/already has an embedded wallet/i.test(String(error?.message ?? error))) throw error;
      }
    }
    const loaded = await waitFor((state) => state.wallet, {
      timeoutMs: WALLET_TIMEOUT_MS,
      message: "Your wallet is taking longer than usual to load. Try again in a moment.",
    });
    return loaded.address;
  }, [createWallet, waitFor]);

  const signMessage = useCallback(async (message, account) => {
    const current = latest.current.wallet;
    if (!current || (account && current.address.toLowerCase() !== account.toLowerCase())) {
      throw new WalletUnavailableError();
    }
    // The sign-in challenge authorises nothing on-chain and the member has just
    // proved their email, so it is signed without a second confirmation screen.
    // Transactions keep Privy's confirmation prompt.
    const { signature } = await signWithPrivy({ message }, {
      address: current.address,
      uiOptions: { showWalletUIs: false },
    });
    return signature;
  }, [signWithPrivy]);

  const value = useMemo(() => ({
    configured: true,
    // Wallet loading only matters once someone is signed in.
    ready: ready && (!authenticated || walletsReady),
    authenticated: signedIn,
    email: signedIn ? user?.email?.address ?? null : null,
    address,
    isConnected: Boolean(address),
    chainId,
    login,
    ensureWallet,
    signMessage,
    accessToken: getAccessToken,
    logout,
  }), [ready, authenticated, walletsReady, signedIn, user, address, chainId,
    login, ensureWallet, signMessage, getAccessToken, logout]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
