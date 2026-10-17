import { useEffect, useRef, useState } from "react";
import { useSession } from "../context/SessionContext.jsx";
import { useWallet } from "../context/WalletContext.jsx";
import {
  getPendingSponsoredTransaction,
  isSponsoredTransactionInFlight,
  recoverPendingSponsoredTransaction,
  subscribePendingSponsoredTransactions,
} from "../lib/embeddedWallet.js";

/**
 * A saved operation that the action in progress in this tab still owns is not
 * unresolved yet: that action reports its own progress. The banner is for a
 * record from an earlier action, another tab or page load, or one the action
 * left behind when it failed or was abandoned.
 */
function unresolvedSend(address) {
  const pending = address ? getPendingSponsoredTransaction(address) : null;
  return pending && !isSponsoredTransactionInFlight(address, pending.id) ? pending : null;
}

/** Recovery only reads an existing operation; it never opens a new wallet send. */
export function WalletTransactionRecovery() {
  const session = useSession();
  const wallet = useWallet();
  const address = session.isSignedIn && wallet.address?.toLowerCase() === session.address?.toLowerCase()
    ? wallet.address : null;
  const currentAddress = useRef(address);
  currentAddress.current = address;
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    setBusy(false);
    setMessage(null);
    const update = () => setPending(unresolvedSend(address));
    update();
    return subscribePendingSponsoredTransactions(update);
  }, [address]);

  const check = async () => {
    if (busy || !address) return;
    setBusy(true);
    setMessage(null);
    try {
      const hash = await recoverPendingSponsoredTransaction({ wallet: { address }, timeoutMs: 10_000 });
      if (currentAddress.current !== address) return;
      setMessage(hash
        ? "Your wallet transaction confirmed. Refresh the affected record to update funding or finish saving your publication."
        : "There is no pending wallet transaction. Refresh the affected record before continuing.");
    } catch (error) {
      if (currentAddress.current !== address) return;
      setMessage(error.message || "Confirmation is still unavailable. Check again before starting another transaction.");
    } finally {
      if (currentAddress.current === address) {
        setPending(unresolvedSend(address));
        setBusy(false);
      }
    }
  };

  if (!address || (!pending && !message)) return null;
  return <aside className="notice" aria-label="Wallet transaction recovery">
    {pending && <>
      <p>{pending.id === "unreadable"
        ? "A previous wallet request could not be restored. Contact an administrator to check its status before starting another transaction."
        : "A wallet transaction may already have been sent. Check its confirmation before starting another transaction."}</p>
      {pending.transactionHash && <p><a href={`https://sepolia.arbiscan.io/tx/${pending.transactionHash}`} target="_blank" rel="noreferrer">View pending wallet transaction</a></p>}
      <button type="button" className="secondary small" disabled={busy} onClick={check}>{busy ? "Checking wallet transaction…" : "Check wallet transaction"}</button>
    </>}
    {message && <p role="status">{message}</p>}
  </aside>;
}
