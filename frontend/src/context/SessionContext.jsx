import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useDisconnect, useSignMessage } from "wagmi";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth, isFirebaseConfigured } from "../lib/firebase.js";
import { exchangeSignatureForSession, requestSignInMessage } from "../lib/authFlow.js";
import { createProfile, findProfileByAddress } from "../lib/profile.js";
import { messageForFirebaseError } from "../lib/errors.js";

const SessionContext = createContext(null);

/**
 * Session states:
 *   signed-out       no verified wallet
 *   verifying        signing the server's message and exchanging it for a token
 *   checking         verified, looking the address up in Firestore
 *   needs-onboarding verified but no profile, so the onboarding modal opens
 *   signed-in        verified and a profile exists
 *
 * Nothing reaches Firestore until `verifying` has completed against the server.
 */
export function SessionProvider({ children }) {
  const { address } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const { signMessageAsync } = useSignMessage();

  const [status, setStatus] = useState("signed-out");
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [verifiedAddress, setVerifiedAddress] = useState(null);

  const lookupToken = useRef(0);

  const reset = useCallback(() => {
    lookupToken.current += 1;
    setStatus("signed-out");
    setProfile(null);
    setVerifiedAddress(null);
  }, []);

  // Firebase persists the custom-token session, so a reload restores it without
  // asking the user to sign again. The uid IS the wallet address.
  useEffect(() => {
    if (!isFirebaseConfigured) return undefined;
    return onAuthStateChanged(auth, (user) => {
      if (user?.uid) setVerifiedAddress(user.uid.toLowerCase());
      else setVerifiedAddress(null);
    });
  }, []);

  // Returns { ok, rejected } instead of throwing, so callers (the connector picker,
  // the direct sign-in button) can each decide how to react without an unhandled
  // promise rejection - and so `error` in context is never the ONLY place a failure
  // is visible.
  const signIn = useCallback(
    async (connectedAddress) => {
      const target = (connectedAddress ?? address)?.toLowerCase();
      if (!target) return { ok: false, rejected: false };

      setError(null);
      setStatus("verifying");

      try {
        const message = await requestSignInMessage(target);
        const signature = await signMessageAsync({ message, account: target });
        await exchangeSignatureForSession({ address: target, signature });
        setVerifiedAddress(target);
        return { ok: true, rejected: false };
      } catch (caught) {
        // A rejected signature is a normal user choice, not a failure to report loudly.
        const rejected = caught?.name === "UserRejectedRequestError" || caught?.code === 4001;
        setError(rejected ? null : messageForFirebaseError(caught));
        setStatus("signed-out");
        await disconnectAsync().catch(() => {});
        return { ok: false, rejected };
      }
    },
    [address, signMessageAsync, disconnectAsync],
  );

  // Once an address is verified, decide between onboarding and a normal sign-in.
  useEffect(() => {
    if (!verifiedAddress) {
      if (status !== "verifying") reset();
      return;
    }

    const token = (lookupToken.current += 1);
    setStatus("checking");

    (async () => {
      try {
        const found = await findProfileByAddress(verifiedAddress);
        if (token !== lookupToken.current) return;
        setProfile(found);
        setStatus(found ? "signed-in" : "needs-onboarding");
      } catch (caught) {
        if (token !== lookupToken.current) return;
        setError(messageForFirebaseError(caught));
        setStatus("signed-out");
      }
    })();
  }, [verifiedAddress, reset]);

  // If the wallet switches to a DIFFERENT account, the Firebase session belongs to
  // the wrong address and has to go - otherwise a write could land under the wrong
  // uid. This deliberately does NOT react to `isConnected` alone: some wallet
  // extensions emit a transient `accountsChanged` (briefly empty, or a stale value)
  // during their own internal session checks, unrelated to anything the user did.
  // Treating every such blip as an account switch used to nuke an in-progress
  // onboarding form - typing for ~20s was enough to hit one. The Firebase session
  // is independent of wagmi's live connection status anyway: the uid was fixed by a
  // signature at sign-in time, so a momentary "disconnected" reading from wagmi is
  // not itself a reason to end it.
  useEffect(() => {
    if (!verifiedAddress) return;
    const switchedToADifferentAccount = address && address.toLowerCase() !== verifiedAddress;
    if (!switchedToADifferentAccount) return;
    if (isFirebaseConfigured && auth.currentUser) signOut(auth).catch(() => {});
    reset();
  }, [address, verifiedAddress, reset]);

  const completeOnboarding = useCallback(
    async (form) => {
      const created = await createProfile({ form, address: verifiedAddress });
      setProfile(created);
      setStatus("signed-in");
      return created;
    },
    [verifiedAddress],
  );

  const signOutOfSession = useCallback(async () => {
    if (isFirebaseConfigured && auth.currentUser) {
      await signOut(auth).catch(() => {});
    }
    await disconnectAsync().catch(() => {});
    reset();
    setError(null);
  }, [disconnectAsync, reset]);

  const applyProfilePatch = useCallback((patch) => {
    setProfile((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const value = useMemo(
    () => ({
      status,
      profile,
      error,
      address: verifiedAddress,
      isSignedIn: status === "signed-in",
      needsOnboarding: status === "needs-onboarding",
      isVerifying: status === "verifying",
      isChecking: status === "checking",
      isBusy: status === "verifying" || status === "checking",
      signIn,
      completeOnboarding,
      cancelOnboarding: signOutOfSession,
      signOut: signOutOfSession,
      applyProfilePatch,
    }),
    [status, profile, error, verifiedAddress, signIn, completeOnboarding, signOutOfSession, applyProfilePatch],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside a SessionProvider");
  return context;
}
