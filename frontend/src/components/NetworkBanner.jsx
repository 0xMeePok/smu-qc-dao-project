import { useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { EXPECTED_CHAIN_ID, EXPECTED_CHAIN_NAME } from "../lib/chain.js";

/**
 * Shown whenever a connected wallet is on the wrong chain - independent of the
 * sign-in flow, so switching away mid-session (not just at the moment of signing
 * in) is caught too.
 *
 * Reads `chainId` off `useAccount()`, NOT `useChainId()`. wagmi tracks two separate
 * things: a top-level "preferred" chainId seeded from `chains[0]` that only changes
 * when something explicitly calls `switchChain()`, and each connection's own chainId,
 * which is what actually updates when the wallet reports switching networks on its
 * own. `useChainId()` reads the first one, so it never reacts to the user changing
 * networks in their wallet directly - confirmed live: a real `chainChanged` event
 * updates `useAccount().chainId` immediately but leaves `useChainId()` unmoved.
 */
export function NetworkBanner() {
  const { isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState(null);

  if (!isConnected || chainId === EXPECTED_CHAIN_ID) return null;

  const switchNetwork = async () => {
    setSwitching(true);
    setError(null);
    try {
      await switchChainAsync({ chainId: EXPECTED_CHAIN_ID });
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
