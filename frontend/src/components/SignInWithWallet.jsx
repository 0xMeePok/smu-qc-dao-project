import { useState } from "react";
import { useAccount } from "wagmi";
import { useSession } from "../context/SessionContext.jsx";
import { WalletIcon } from "./WalletIcon.jsx";
import { ConnectWalletModal } from "./ConnectWalletModal.jsx";

/**
 * Always reads "Sign in with Wallet", whether or not a wallet extension is present.
 * Someone with nothing installed still gets a useful path: the picker explains what
 * to install.
 */
export function SignInWithWallet() {
  const [pickerOpen, setPickerOpen] = useState(false);
  const { isConnected } = useAccount();
  const { signIn, error, isVerifying, isChecking, isBusy } = useSession();

  const label = isVerifying
    ? "Confirm in your wallet…"
    : isChecking
      ? "Signing in…"
      : "Sign in with Wallet";

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
