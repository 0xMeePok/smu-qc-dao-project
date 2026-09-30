import { useState } from "react";
import { useWallet } from "../context/WalletContext.jsx";
import { EXPECTED_CHAIN_ID, EXPECTED_CHAIN_NAME } from "../lib/chain.js";

/**
 * Shown whenever the Privy wallet is on the wrong chain. The chain id comes from
 * the wallet Privy connected, including a change the user makes in that wallet.
 */
export function NetworkBanner() {
  const { isConnected, chainId, switchChain } = useWallet();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState(null);

  if (!isConnected || chainId === EXPECTED_CHAIN_ID) return null;

  const switchNetwork = async () => {
    setSwitching(true);
    setError(null);
    try {
      await switchChain(EXPECTED_CHAIN_ID);
    } catch (caught) {
      const rejected = caught?.name === "UserRejectedRequestError" || caught?.code === 4001;
      setError(
        rejected
          ? null
          : caught?.name === "SwitchChainNotSupportedError"
            ? `Your wallet does not support switching networks automatically. Switch to ${EXPECTED_CHAIN_NAME} yourself.`
            : "Could not switch networks. Try again, or switch in your wallet directly.",
      );
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="network-banner" role="alert">
      <span>
        Your wallet is on the wrong network. This app runs on <strong>{EXPECTED_CHAIN_NAME}</strong>.
        {error ? <span className="network-banner-error"> {error}</span> : null}
      </span>
      <button className="secondary" type="button" onClick={switchNetwork} disabled={switching}>
        {switching ? "Switching…" : `Switch to ${EXPECTED_CHAIN_NAME}`}
      </button>
    </div>
  );
}
