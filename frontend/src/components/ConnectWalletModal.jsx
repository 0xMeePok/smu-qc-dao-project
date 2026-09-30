import { useState } from "react";
import { useLogin, usePrivy } from "@privy-io/react-auth";
import { useSession } from "../context/SessionContext.jsx";
import { ethereumAddressFromPrivyUser, privyAppId } from "../lib/privy.js";
import { WalletIcon } from "./WalletIcon.jsx";
import { Modal } from "./Modal.jsx";

/**
 * Privy is the only wallet connection. After Privy returns an Ethereum address,
 * the existing server-checked signature still creates the Firebase session.
 */
export function ConnectWalletModal({ onClose }) {
  if (!privyAppId) return <PrivyNotConfigured onClose={onClose} />;
  return <PrivyConnect onClose={onClose} />;
}

function PrivyNotConfigured({ onClose }) {
  return (
    <Modal className="modal-narrow" labelledBy="connect-title" onDismiss={onClose}>
      <header className="modal-head">
        <span className="modal-badge modal-badge-brand" aria-hidden="true"><WalletIcon /></span>
        <div>
          <h2 id="connect-title">Sign in with Privy</h2>
          <p>Add VITE_PRIVY_APP_ID to frontend/.env.local and restart the dev server. Create the app in the Privy dashboard first.</p>
        </div>
      </header>
      <footer className="modal-actions">
        <button className="secondary" type="button" onClick={onClose}>Close</button>
      </footer>
    </Modal>
  );
}

function PrivyConnect({ onClose }) {
  const { signIn } = useSession();
  const { authenticated, user } = usePrivy();
  const [pending, setPending] = useState(false);
  const [phase, setPhase] = useState(null);
  const [error, setError] = useState(null);

  const authorize = async (privyUser) => {
    const address = ethereumAddressFromPrivyUser(privyUser);
    if (!address) {
      setError("Privy did not return an Ethereum wallet. Try again.");
      setPending(false);
      setPhase(null);
      return;
    }
    setPhase("authorizing");
    const outcome = await signIn(address);
    if (outcome.ok) {
      onClose();
      return;
    }
    if (!outcome.rejected) {
      setError(outcome.message ?? "Sign-in could not be verified. Please try again.");
    }
    setPending(false);
    setPhase(null);
  };

  const { login } = useLogin({
    onComplete: ({ user: loggedInUser }) => authorize(loggedInUser),
    onError: (caught) => {
      const message = caught?.message ?? "Privy could not connect.";
      if (/already logged in/i.test(message) && user) {
        authorize(user);
        return;
      }
      setError(message);
      setPending(false);
      setPhase(null);
    },
  });

  const start = () => {
    setError(null);
    setPending(true);
    if (authenticated && user) {
      authorize(user);
      return;
    }
    setPhase("connecting");
    login();
  };

  return (
    <Modal className="modal-narrow" labelledBy="connect-title" onDismiss={pending ? undefined : onClose}>
      <header className="modal-head">
        <span className="modal-badge modal-badge-brand" aria-hidden="true"><WalletIcon /></span>
        <div>
          <h2 id="connect-title">Sign in with Privy</h2>
          <p>Use email to create a wallet, or connect one you already have. You will then sign a short message proving that wallet is yours. It costs no gas and moves no funds.</p>
        </div>
      </header>

      {error ? (
        <div className="notice notice-error" role="alert">
          <p>{error}</p>
        </div>
      ) : null}

      <div className="connector-list">
        <button className="connector" type="button" onClick={start} disabled={pending}>
          <span className="connector-mark" aria-hidden="true"><WalletIcon /></span>
          <span>Continue with Privy</span>
          {pending ? <small>{phase === "connecting" ? "Connecting…" : "Authorising…"}</small> : null}
        </button>
      </div>

      <footer className="modal-actions">
        <button className="secondary" type="button" onClick={onClose} disabled={pending}>
          Cancel
        </button>
      </footer>
    </Modal>
  );
}
