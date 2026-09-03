import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useDisconnect, useSignMessage } from "wagmi";
import { getConnection, switchChain } from "wagmi/actions";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { onSnapshot, doc } from "firebase/firestore";
import { auth, db, isFirebaseConfigured } from "../lib/firebase.js";
import { exchangeSignatureForSession, requestSignInMessage, revokeOwnSessions } from "../lib/authFlow.js";
import { createProfile, findProfileByAddress, updateProfile } from "../lib/profile.js";
import { messageForFirebaseError } from "../lib/errors.js";
import { EXPECTED_CHAIN_ID, EXPECTED_CHAIN_NAME } from "../lib/chain.js";
import { wagmiConfig } from "../lib/wagmi.js";
import { isAdmin } from "../lib/roles.js";
import { go } from "../lib/router.js";
import {
  IDLE_CHECK_INTERVAL_MS,
  clearActivity,
  hasActivityRecord,
  isIdleExpired,
  markActivity,
} from "../lib/idleTimeout.js";

export const SessionContext = createContext(null);

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

  // Starts TRUE when Firebase was never configured: there is no persisted session
  // that could arrive late, so the app should render immediately rather than hang on
  // a loading state forever.
  const [authResolved, setAuthResolved] = useState(!isFirebaseConfigured);

  const lookupToken = useRef(0);

  const reset = useCallback(() => {
    lookupToken.current += 1;
    setStatus("signed-out");
    setProfile(null);
    setVerifiedAddress(null);
    setError(null);
  }, []);

  // Firebase persists the custom-token session, so a reload restores it without
  // asking the user to sign again. The uid IS the wallet address.
  useEffect(() => {
    if (!isFirebaseConfigured) return undefined;
    return onAuthStateChanged(auth, (user) => {
      if (user?.uid) {
        setVerifiedAddress(user.uid.toLowerCase());
        // Set alongside the address rather than left to the lookup effect below.
        // That effect runs a tick later, and in the gap `status` would still say
        // "signed-out" while `verifiedAddress` was already set - a one-frame
        // contradiction a route guard reads as "not signed in" and acts on.
        setStatus("checking");
      } else {
        setVerifiedAddress(null);
      }
      setAuthResolved(true);
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
        // `getConnection(config).chainId` - NOT `getChainId(config)`. wagmi keeps two
        // separate ideas of "chain": a top-level `config.state.chainId` that is
        // seeded from `chains[0]` at startup and is only ever touched by an explicit
        // `switchChain()` call, and each connection's own `chainId`, set from what
        // the wallet actually reported at connect time. `getChainId()` reads the
        // first one, which is why it silently returned 421614 (our only configured
        // chain) even while a wallet sitting on mainnet was connected - it was never
        // wired to the real connection at all, not a matter of the value being stale.
        //
        // The network switch and the nonce fetch run CONCURRENTLY, not one after the
        // other. They used to be sequential because the switch reads as a
        // prerequisite for "the wallet should be on the right chain before it sees a
        // message claiming Chain ID: 421614" - but that message text is static server
        // side (see buildMessage() in functions/index.js) and never actually depends
        // on what chain the wallet is on AT REQUEST TIME, only at signing time, which
        // is still safely after both of these resolve. Running them together removes
        // a whole network round trip from the critical path (the wallet's own
        // wallet_addEthereumChain/wallet_switchEthereumChain RPC) every time a switch
        // is needed - previously the getSiweNonce call (already the slowest single
        // step here - a cross-region Cloud Functions request) didn't even START until
        // that finished. wagmi's switchChain already falls back to
        // `wallet_addEthereumChain` (using arbitrumSepolia's own defaults - no custom
        // RPC/currency needed) when the wallet has never heard of the chain, so this
        // one call still covers both "wrong network" and "network not added yet".
        //
        // If the user dismisses the switch prompt a nonce may already have been
        // issued and left pending, but that costs them nothing: getSiweNonce is
        // idempotent while a nonce is unexpired, so the retry gets the same message
        // back rather than an error.
        const needsSwitch = getConnection(wagmiConfig).chainId !== EXPECTED_CHAIN_ID;
        const [message] = await Promise.all([
          requestSignInMessage(target),
          needsSwitch ? switchChain(wagmiConfig, { chainId: EXPECTED_CHAIN_ID }) : null,
        ]);

        const signature = await signMessageAsync({ message, account: target });
        await exchangeSignatureForSession({ address: target, signature });
        // Start the idle clock from a real, deliberate sign-in.
        markActivity({ force: true });
        setVerifiedAddress(target);
        return { ok: true, rejected: false };
      } catch (caught) {
        // A rejected signature or a declined network switch is a normal user choice,
        // not a failure to report loudly.
        const rejected = caught?.name === "UserRejectedRequestError" || caught?.code === 4001;
        const failureMessage = rejected
          ? null
          : caught?.name === "SwitchChainNotSupportedError"
            ? `Your wallet does not support switching networks automatically. Switch to ${EXPECTED_CHAIN_NAME} yourself, then try again.`
            : messageForFirebaseError(caught);
        setError(failureMessage);
        setStatus("signed-out");
        await disconnectAsync().catch(() => { });
        // The message is returned, not just set into context state, because a caller
        // that awaits signIn() and immediately reads `error` off useSession() (as
        // ConnectWalletModal used to) gets a STALE value: `error` was destructured
        // from context at that component's last render, before this setError() call
        // existed, and closures do not retroactively pick up a later state update.
        // That bug meant every failure showed the same generic fallback string no
        // matter what messageForFirebaseError actually produced.
        return { ok: false, rejected, message: failureMessage };
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

    let hasRoutedToAdmin = false;

    const unsubscribe = onSnapshot(
      doc(db, "users", verifiedAddress.toLowerCase()),
      (snapshot) => {
        if (token !== lookupToken.current) return;
        const found = snapshot.exists() ? snapshot.data() : null;
        setProfile(found);
        setStatus(found ? "signed-in" : "needs-onboarding");

        // Fires once per session establishment (this effect only re-runs when
        // verifiedAddress changes - a fresh sign-in or a restored session on page
        // load), not on every render, so navigating elsewhere afterward doesn't
        // keep yanking an admin back here.
        if (found && isAdmin(found.role) && !found.suspended && !hasRoutedToAdmin) {
          hasRoutedToAdmin = true;
          go("admin");
        }
      },
      (caught) => {
        if (token !== lookupToken.current) return;
        setError(messageForFirebaseError(caught));
        setStatus("signed-out");
      }
    );

    return () => unsubscribe();
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
    if (!verifiedAddress) return undefined;
    const switchedToADifferentAccount = address && address.toLowerCase() !== verifiedAddress;
    if (!switchedToADifferentAccount) return undefined;

    let cancelled = false;
    (async () => {
      try {
        if (isFirebaseConfigured && auth.currentUser) {
          await signOut(auth);
        }
        if (cancelled) return;
        clearActivity();
        reset();
      } catch (caught) {
        if (cancelled) return;
        setError(messageForFirebaseError(caught));
      }
    })();

    return () => {
      cancelled = true;
    };
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

  const saveProfile = useCallback(
    async (form) => {
      const updated = await updateProfile({ form, address: verifiedAddress });
      setProfile(updated);
      return updated;
    },
    [verifiedAddress],
  );

  const endSession = useCallback(
    async ({ reason = null, redirectToLogin = false } = {}) => {
      setError(null);
      try {
        if (isFirebaseConfigured && auth.currentUser) {
          // Invalidate server credentials first. A failure here means the session
          // is still live, so the UI must not claim logout.
          await revokeOwnSessions();
        }
      } catch (caught) {
        const message = messageForFirebaseError(caught);
        setError(message);
        return { ok: false, message };
      }

      // Revocation succeeded, so the token is already dead server-side. Local
      // teardown therefore runs even if signOut throws: bailing out here would
      // leave the app "signed in" holding a token every rule refuses, which
      // fails as an unexplained 403 on the next read or upload.
      if (isFirebaseConfigured && auth.currentUser) {
        await signOut(auth).catch(() => { });
      }

      await disconnectAsync().catch(() => { });
      clearActivity();
      reset();
      setError(
        reason === "idle"
          ? "You were signed out after 15 minutes of inactivity. Sign in again to continue."
          : null,
      );
      if (redirectToLogin) go("login");
      return { ok: true };
    },
    [disconnectAsync, reset],
  );

  const signOutOfSession = useCallback(
    () => endSession({ redirectToLogin: true }),
    [endSession],
  );

  // Idle timeout. Mounts only while a session exists, so nothing runs for a
  // signed-out visitor.
  useEffect(() => {
    if (!verifiedAddress) return undefined;

    // Runs on mount too, which is what catches a RESTORED session that already
    // lapsed: Firebase persists the login indefinitely, so a tab reopened the next
    // morning would otherwise come back signed in.
    if (isIdleExpired()) {
      endSession({ reason: "idle" });
      return undefined;
    }

    // A restored session with no stored activity (cleared storage, or a session
    // predating this) starts its clock now rather than being treated as infinitely
    // idle and killed on sight.
    if (!hasActivityRecord()) markActivity({ force: true });

    const noteActivity = () => markActivity();
    const activityEvents = ["pointerdown", "keydown", "scroll", "focus"];
    activityEvents.forEach((name) =>
      window.addEventListener(name, noteActivity, { passive: true }),
    );

    const checkExpiry = () => {
      if (isIdleExpired()) endSession({ reason: "idle" });
    };

    // Background tabs get their timers throttled hard, so the interval alone can fire
    // well past the deadline. Re-checking the moment a tab becomes visible covers the
    // case an idle timeout actually exists for: left open, come back later.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") checkExpiry();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const interval = window.setInterval(checkExpiry, IDLE_CHECK_INTERVAL_MS);

    return () => {
      activityEvents.forEach((name) => window.removeEventListener(name, noteActivity));
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(interval);
    };
  }, [verifiedAddress, endSession]);

  const value = useMemo(
    () => ({
      status,
      profile,
      error,
      address: verifiedAddress,
      // True while the app cannot yet answer "who is this, and what may they see?" -
      // either Firebase has not reported on a persisted session, or it has and the
      // profile carrying the role is still being fetched. Route guards block on this.
      isLoading: !authResolved || status === "checking",
      isSignedIn: status === "signed-in",
      isSuspended: Boolean(profile?.suspended),
      needsOnboarding: status === "needs-onboarding",
      isVerifying: status === "verifying",
      isChecking: status === "checking",
      isBusy: status === "verifying" || status === "checking",
      signIn,
      completeOnboarding,
      saveProfile,
      cancelOnboarding: signOutOfSession,
      signOut: signOutOfSession,
    }),
    [status, profile, error, verifiedAddress, authResolved, signIn, completeOnboarding, saveProfile, signOutOfSession],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside a SessionProvider");
  return context;
}
