import { useCallback, useContext, useEffect, useMemo, useState, createContext } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { arbitrumSepolia } from "viem/chains";
import { registerActiveWallet } from "../lib/activeWallet.js";
import { EXPECTED_CHAIN_ID } from "../lib/chain.js";
import { ethereumAddressFromPrivyUser, privyAppId } from "../lib/privy.js";
import { registerPrivyLogout } from "../lib/privyLogout.js";
import { PrivyWalletNotReadyError, registerSignPrivyMessage, signWithEthereumProvider } from "../lib/privyWallet.js";

const disconnected = {
  address: null,
  isConnected: false,
  chainId: undefined,
  switchChain: async () => {
    const error = new Error("Privy is not configured.");
    error.name = "SwitchChainNotSupportedError";
    throw error;
  },
};

const WalletContext = createContext(disconnected);

export function useWallet() {
  return useContext(WalletContext);
}

function chainIdOf(wallet) {
  const raw = wallet?.chainId;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.startsWith("eip155:")) return Number(raw.slice("eip155:".length));
  if (typeof raw === "string" && raw.startsWith("0x")) return Number(raw);
  return undefined;
}

function rejected(error) {
  return error?.name === "UserRejectedRequestError" || error?.code === 4001;
}

export function WalletProvider({ children }) {
  if (!privyAppId) return <WalletContext.Provider value={disconnected}>{children}</WalletContext.Provider>;
  return <LiveWallet>{children}</LiveWallet>;
}

function LiveWallet({ children }) {
  const { authenticated, ready, user, logout, signMessage } = usePrivy();
  const { wallets } = useWallets();
  const linked = ethereumAddressFromPrivyUser(user)?.toLowerCase() ?? null;
  const wallet = useMemo(
    () => wallets.find((item) => item.address?.toLowerCase() === linked)
      ?? wallets.find((item) => item.address),
    [wallets, linked],
  );
  const [chainId, setChainId] = useState(() => chainIdOf(wallet));

  useEffect(() => {
    setChainId(chainIdOf(wallet));
    if (typeof wallet?.getEthereumProvider !== "function") return undefined;
    let provider;
    let onChange;
    let cancelled = false;
    (async () => {
      try {
        provider = await wallet.getEthereumProvider();
        if (cancelled || !provider?.request) return;
        const hex = await provider.request({ method: "eth_chainId" });
        if (!cancelled) setChainId(Number(hex));
        onChange = (next) => setChainId(Number(next));
        provider.on?.("chainChanged", onChange);
      } catch {
        // Keep the chain id Privy already reported on the wallet.
      }
    })();
    return () => {
      cancelled = true;
      provider?.removeListener?.("chainChanged", onChange);
    };
  }, [wallet]);

  const switchChain = useCallback(async (id) => {
    if (typeof wallet?.switchChain === "function") {
      await wallet.switchChain(id);
      setChainId(id);
      return;
    }
    if (typeof wallet?.getEthereumProvider !== "function") {
      const error = new Error("This wallet cannot switch networks automatically.");
      error.name = "SwitchChainNotSupportedError";
      throw error;
    }
    const provider = await wallet.getEthereumProvider();
    const hex = `0x${Number(id).toString(16)}`;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (error) {
      if (error?.code !== 4902) throw error;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hex,
          chainName: arbitrumSepolia.name,
          nativeCurrency: arbitrumSepolia.nativeCurrency,
          rpcUrls: arbitrumSepolia.rpcUrls.default.http,
          blockExplorerUrls: [arbitrumSepolia.blockExplorers?.default?.url].filter(Boolean),
        }],
      });
    }
    setChainId(id);
  }, [wallet]);

  useEffect(() => {
    registerPrivyLogout(logout);
    registerActiveWallet({
      address: wallet?.address ?? null,
      chainId: chainId ?? EXPECTED_CHAIN_ID,
      getProvider: typeof wallet?.getEthereumProvider === "function"
        ? () => wallet.getEthereumProvider()
        : null,
    });

    registerSignPrivyMessage(async (address, message) => {
      const match = wallets.find((item) => item.address?.toLowerCase() === address.toLowerCase()) ?? wallet;
      if (typeof match?.getEthereumProvider === "function") {
        try {
          const provider = await match.getEthereumProvider();
          return await signWithEthereumProvider({
            provider,
            address: match.address,
            message,
            chain: arbitrumSepolia,
          });
        } catch (error) {
          if (rejected(error)) throw error;
        }
      }
      try {
        const result = await signMessage({ message }, { address });
        if (result?.signature) return result.signature;
      } catch (error) {
        if (rejected(error)) throw error;
      }
      throw new PrivyWalletNotReadyError();
    });

    return () => {
      registerPrivyLogout(null);
      registerActiveWallet(null);
      registerSignPrivyMessage(null);
    };
  }, [logout, wallet, chainId, wallets, signMessage]);

  const value = useMemo(() => ({
    address: wallet?.address ?? null,
    isConnected: Boolean(ready && authenticated && wallet?.address),
    chainId: chainId ?? EXPECTED_CHAIN_ID,
    switchChain,
  }), [wallet, ready, authenticated, chainId, switchChain]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
