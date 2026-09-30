import { useState } from "react";
import { useWallet } from "../context/WalletContext.jsx";
import { useSession } from "../context/SessionContext.jsx";
import { WalletIcon } from "./WalletIcon.jsx";
import { ConnectWalletModal } from "./ConnectWalletModal.jsx";

/**
 * Opens Privy, then the existing signature check. An already connected wallet
 * skips the Privy modal and goes straight to that signature.
 */
export function SignInWithWallet() {
  const [pickerOpen, setPickerOpen] = useState(false);
  const { isConnected } = useWallet();
  const { signIn, error, isVerifying, isChecking, isBusy } = useSession();

  const label = isVerifying
    ? "Confirm in your wallet…"
    : isChecking
      ? "Signing in…"
      : "Sign in with Privy";

  const start = async () => {
    // Already connected but not verified - go straight to the signature step.
    // Reopen the picker on failure so the reason is visible rather than silent.
    if (isConnected) {
      const outcome = await signIn();
      if (!outcome?.ok && !outcome?.rejected) setPickerOpen(true);
    } else {
      setPickerOpen(true);
    }
  };

  return (
    <>
      <button className="primary wallet-button" type="button" onClick={start} disabled={isBusy}>
        <WalletIcon />
        {label}
      </button>
      {pickerOpen ? <ConnectWalletModal onClose={() => setPickerOpen(false)} /> : null}
      {error && !pickerOpen ? (
        <span className="signin-error" role="alert">{error}</span>
      ) : null}
    </>
  );
}
