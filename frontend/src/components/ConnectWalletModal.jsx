import { useState } from "react";
import { useConnect } from "wagmi";
import { useSession } from "../context/SessionContext.jsx";
import { isUsableConnector } from "../lib/wagmi.js";
import { WalletIcon } from "./WalletIcon.jsx";
import { Modal } from "./Modal.jsx";

/**
 * Connector picker. Entries come from EIP-6963 discovery, filtered by
 * `isUsableConnector` to MetaMask and Rabby only - see lib/wagmi.js.
 */
export function ConnectWalletModal({ onClose }) {
  const { connectors, connectAsync } = useConnect();
  const { signIn } = useSession();
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);

  // The modal stays open until sign-in genuinely succeeds. It used to close right
  // after `connectAsync`, before the signature step even ran - so if verification
  // failed (e.g. Firebase not configured), the modal vanished and nothing told the
  // user why. Closing only on a real `ok` result fixes that.
  const choose = async (connector) => {
    setError(null);
    setPending(connector.uid);
    try {
      const result = await connectAsync({ connector });
      const outcome = await signIn(result.accounts?.[0]);
      if (outcome.ok) {
        onClose();
        return;
      }
      if (!outcome.rejected) {
        // `outcome.message` is returned directly from signIn(), not read back off
        // context state - reading useSession().error here used to be stale (it was
        // captured at this component's last render, before signIn() had set it),
        // so every real failure fell through to the generic string below regardless
        // of what actually went wrong.
        setError(outcome.message ?? "Sign-in could not be verified. Please try again.");
      }
      // A rejected signature needs no error text - the button just becomes
      // available again so the user can retry.
    } catch (caught) {
      const rejected = caught?.name === "UserRejectedRequestError" || caught?.code === 4001;
      setError(
        rejected
          ? "You dismissed the wallet request."
          : (caught?.shortMessage ?? caught?.message ?? "That wallet could not connect."),
      );
    } finally {
      setPending(null);
    }
  };

  // The same wallet can be announced more than once; collapse by name.
  const seen = new Set();
  const available = connectors.filter((connector) => {
    if (!isUsableConnector(connector)) return false;
    const key = connector.name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return (
    <Modal className="modal-narrow" labelledBy="connect-title" onDismiss={onClose}>
      <header className="modal-head">
        <span className="modal-badge modal-badge-brand" aria-hidden="true"><WalletIcon /></span>
        <div>
          <h2 id="connect-title">Sign in with Wallet</h2>
          <p>
            {available.length > 0
              ? "Choose a wallet. You will be asked to sign a short message proving the wallet is yours — it costs no gas and moves no funds."
              : "We could not find MetaMask or Rabby in this browser. Install one of them to sign in."}
          </p>
        </div>
      </header>

      {error ? (
        <div className="notice notice-error" role="alert">
          <p>{error}</p>
        </div>
      ) : null}

      {available.length > 0 ? (
        <div className="connector-list">
          {available.map((connector) => (
            <button
              className="connector"
              key={connector.uid}
              type="button"
              onClick={() => choose(connector)}
              disabled={pending !== null}
            >
              {connector.icon ? (
                <img src={connector.icon} alt="" width="22" height="22" />
              ) : (
                <span className="connector-mark" aria-hidden="true"><WalletIcon /></span>
              )}
              <span>{connector.name}</span>
              {pending === connector.uid ? <small>Connecting…</small> : null}
            </button>
          ))}
        </div>
      ) : (
        <div className="connector-empty">
          <p>
            MetaMask or Rabby, either works — install one, then reload this page and
            it will appear here.
          </p>
          <div className="connector-empty-links">
            <a
              className="primary wallet-button"
              href="https://metamask.io/download/"
              target="_blank"
              rel="noreferrer noopener"
            >
              <WalletIcon />
              Get MetaMask
            </a>
            <a
              className="secondary wallet-button"
              href="https://rabby.io/"
              target="_blank"
              rel="noreferrer noopener"
            >
              <WalletIcon />
              Get Rabby
            </a>
          </div>
        </div>
      )}

      <footer className="modal-actions">
        <button className="secondary" type="button" onClick={onClose} disabled={pending !== null}>
          Cancel
        </button>
      </footer>
    </Modal>
  );
}
