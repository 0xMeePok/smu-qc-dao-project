import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { onSnapshot, doc } from "firebase/firestore";
import { auth, db, isFirebaseConfigured } from "../lib/firebase.js";
import { exchangePrivySession, revokeOwnSessions } from "../lib/authFlow.js";
import { createProfile, findProfileByAddress, updateProfile } from "../lib/profile.js";
import { ACCOUNT_SUSPENDED_MESSAGE, isSignInCancelled, messageForFirebaseError, messageForSignInError } from "../lib/errors.js";
import { go, parseRoute } from "../lib/router.js";
import { useWallet } from "./WalletContext.jsx";
import {
  IDLE_CHECK_INTERVAL_MS,
  clearActivity,
  hasActivityRecord,
  isIdleExpired,
  markActivity,
} from "../lib/idleTimeout.js";

export const SessionContext = createContext(null);

const IDLE_MESSAGE = "You were signed out after one hour of inactivity. Sign in again to continue.";

/**
 * Session states:
 *   signed-out       no verified account
 *   verifying        a new sign-in: Privy's login modal is open, or the
 *                    member's embedded wallet is loading and its access token
 *                    is being exchanged for a Firebase session
 *   checking         verified, looking the address up in Firestore
 *   needs-onboarding verified but no profile, so the onboarding modal opens
 *   signed-in        verified and a profile exists
 *
 * Nothing reaches Firestore until `verifying` has completed against the server.
 *
 * Two sessions back every sign-in: Privy's (the email login that unlocks the
 * embedded wallet) and Firebase's (the custom token minted for that wallet's
 * address). They start together, and sign-out, the idle timeout, suspension and
 * a failed sign-in all end both. A Privy session with no Firebase session beside
 * it - left by a reload, another tab, or a revoked token - is ended on sight.
 */
export function SessionProvider({ children }) {
  const wallet = useWallet();
  // Sign-in spans several renders: each step must use the wallet as it is now,
  // not as it was when the callback was created.
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  const [status, setStatus] = useState("signed-out");
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [signOutReason, setSignOutReason] = useState(null);
  const [verifiedAddress, setVerifiedAddress] = useState(null);
  const [profileLookupVersion, setProfileLookupVersion] = useState(0);

  // Starts TRUE when Firebase was never configured: there is no persisted session
  // that could arrive late, so the app should render immediately rather than hang on
  // a loading state forever.
  const [authResolved, setAuthResolved] = useState(!isFirebaseConfigured);

  const lookupToken = useRef(0);
  const ending = useRef(false);
  // From the click until Firebase and Privy have both cleared their sessions.
  // The ref is for callbacks; the state drives "Signing out…" in the UI.
  const signingOutRef = useRef(false);
  const [signingOut, setSigningOut] = useState(false);
  // A new sign-in after Privy's modal closes: "wallet" (loading the embedded
  // wallet), "session" (exchanging Privy's token for the Firebase session),
  // then "profile" (reading the member's record). Drives SignInProgress.
  const [signInStep, setSignInStep] = useState(null);
  const current = useRef({});
  current.current = { status, profile, verifiedAddress };

  // Clears the session but leaves `error` alone: Firebase reports a sign-out a
  // render after endSession() has already explained why (idle, suspension),
  // and that explanation must survive the report.
  const clearSession = useCallback(() => {
    lookupToken.current += 1;
    setStatus("signed-out");
    setProfile(null);
    setVerifiedAddress(null);
  }, []);

  const reset = useCallback(() => {
    clearSession();
    setError(null);
    setSignOutReason(null);
  }, [clearSession]);

  const logoutOfPrivy = useCallback(() => walletRef.current.logout().catch(() => { }), []);

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

  // One sign-in at a time, however many buttons ask for one.
  const signInInFlight = useRef(null);

  /**
 * Opens Privy's login modal - email and a one-time code; Privy creates the
 * embedded wallet on a first sign-in - then exchanges Privy's access token
 * for the Firebase session.
   *
   * Returns { ok, message } instead of throwing, so a caller can show a failure
   * where the member is looking without an unhandled rejection. Closing Privy's
   * modal is not a failure: { ok: false, cancelled: true }, with no message.
   */
  const signIn = useCallback(() => {
    if (signInInFlight.current) return signInInFlight.current;
    // A sign-out still clearing Privy's session would make the new sign-in look
    // already done to Privy. The sign-in button is disabled meanwhile anyway.
    if (signingOutRef.current) {
      return Promise.resolve({ ok: false, message: "You are still being signed out. Sign in again in a moment." });
    }

    const run = async () => {
      const before = current.current;
      const privyWasSignedIn = walletRef.current.authenticated;
      setError(null);
      setSignOutReason(null);
      // A member who is already signed in keeps their session - and the page
      // they are on - while Privy's modal is open. A new sign-in shows as
      // `verifying`, which also stops the lockstep below from ending the Privy
      // session the modal creates before the Firebase one exists.
      if (!before.verifiedAddress) setStatus("verifying");

      try {
        await walletRef.current.login();
        const step = (name) => { if (!before.verifiedAddress) setSignInStep(name); };
        step("wallet");
        // A returning member's wallet loads; a first sign-in's was just created.
        // The server, not this address, decides who the Firebase session is.
        const local = (await walletRef.current.ensureWallet()).toLowerCase();
        // The Firebase session is already this wallet. Signing in again must
        // still replace a failed profile listener: Firebase may not emit an
        // auth-state event when the uid is unchanged.
        if (local === before.verifiedAddress && before.status === "signed-in") {
          markActivity({ force: true });
          setError(null);
          setStatus("checking");
          setProfileLookupVersion(version => version + 1);
          return { ok: true };
        }

        step("session");
        const accessToken = await walletRef.current.accessToken();
        const address = (await exchangePrivySession(accessToken)).toLowerCase();
        if (address !== local) {
          if (isFirebaseConfigured && auth.currentUser) await signOut(auth).catch(() => {});
          throw new Error("The signed-in wallet does not match this account.");
        }
        // Start the idle clock from a real, deliberate sign-in.
        markActivity({ force: true });
        step("profile");
        setStatus("checking");
        setVerifiedAddress(address);
        // A rejected profile read can mean this Firebase session was revoked.
        // Re-exchange Privy's verified token even when the wallet is unchanged,
        // and restart the listener if Firebase emits no same-uid auth event.
        if (address === before.verifiedAddress) setProfileLookupVersion(version => version + 1);
        return { ok: true };
      } catch (caught) {
        // Lockstep: a sign-in that did not finish must not leave behind a Privy
        // session it started.
        if (!privyWasSignedIn && walletRef.current.authenticated) await logoutOfPrivy();
        setSignInStep(null);
        if (!before.verifiedAddress) setStatus("signed-out");
        if (isSignInCancelled(caught)) return { ok: false, cancelled: true };
        const failureMessage = messageForSignInError(caught);
        setError(failureMessage);
        return { ok: false, message: failureMessage };
      }
    };

    signInInFlight.current = run().finally(() => { signInInFlight.current = null; });
    return signInInFlight.current;
  }, [logoutOfPrivy]);

  // The progress screen ends with the sign-in: signed in, onboarding or signed out.
  useEffect(() => {
    if (status !== "verifying" && status !== "checking") setSignInStep(null);
  }, [status]);

  // Once an address is verified, decide between onboarding and a normal sign-in.
  useEffect(() => {
    if (!verifiedAddress) {
      if (status !== "verifying") clearSession();
      return;
    }

    const token = (lookupToken.current += 1);
    setStatus("checking");

    const unsubscribe = onSnapshot(
      doc(db, "users", verifiedAddress.toLowerCase()),
      (snapshot) => {
        if (token !== lookupToken.current) return;
        const found = snapshot.exists() ? snapshot.data() : null;
        setProfile(found);
        setStatus(found ? "signed-in" : "needs-onboarding");

        // Restoring a profile keeps the current URL. Login handles the landing
        // page after an explicit sign-in, including any interrupted destination.
      },
      (caught) => {
        // Revoking the session on sign-out makes this listener fail at once;
        // that is the sign-out working, not an error to show the member.
        if (token !== lookupToken.current || signingOutRef.current) return;
        setError(messageForFirebaseError(caught));
        setStatus("signed-out");
      }
    );

    return () => unsubscribe();
  }, [verifiedAddress, profileLookupVersion, clearSession]);

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
      signingOutRef.current = true;
      setSigningOut(true);
      // Suspension already revoked this account's credentials server side (see
      // setUserSuspension), and a suspended account may not call back in.
      if (reason !== "suspended") {
        try {
          if (isFirebaseConfigured && auth.currentUser) {
            // Invalidate server credentials first. A failure here means the
            // session is still live, so the UI must not claim logout.
            await revokeOwnSessions();
          }
        } catch (caught) {
          signingOutRef.current = false;
          setSigningOut(false);
          const message = messageForFirebaseError(caught);
          setError(message);
          return { ok: false, message };
        }
      }

      // The token is dead server-side now, so the member IS signed out: show it
      // straight away. Firebase and Privy clear their local sessions after this,
      // and the screen does not wait for them - Privy's logout alone can take 15
      // seconds (it waits on its wallet iframe), and nothing either does matters
      // for security once the server has revoked the session. `ending` is set
      // first so the lockstep effect below does not start a second Privy logout.
      ending.current = true;
      clearActivity();
      reset();
      setSignOutReason(reason);
      setError(reason === "idle" ? IDLE_MESSAGE : reason === "suspended" ? ACCOUNT_SUSPENDED_MESSAGE : null);
      if (reason === "idle") {
        const destination = parseRoute();
        go(destination.split("?")[0] === "login" ? destination : `login?redirect=${encodeURIComponent(destination)}`);
      } else if (redirectToLogin) go("login");

      // Local teardown runs even if signOut throws: bailing out here would leave
      // Firebase holding a token every rule refuses, which fails as an
      // unexplained 403 on the next read or upload.
      try {
        if (isFirebaseConfigured && auth.currentUser) {
          await signOut(auth).catch(() => { });
        }
        await logoutOfPrivy();
      } finally {
        ending.current = false;
        signingOutRef.current = false;
        setSigningOut(false);
      }
      return { ok: true };
    },
    [logoutOfPrivy, reset],
  );

  const signOutOfSession = useCallback(
    () => endSession({ redirectToLogin: true }),
    [endSession],
  );

  // An administrator suspended this account while it was signed in. Both
  // sessions end at once; the server refuses to sign a suspended account back in.
  const suspended = Boolean(verifiedAddress && profile?.suspended);
  useEffect(() => {
    if (suspended) endSession({ reason: "suspended" });
  }, [suspended, endSession]);

  // Lockstep, the other way round: never leave a Privy session without the
  // Firebase session it exists to create. This catches a reload after the
  // Firebase session was revoked or expired, a sign-out in another tab, and an
  // abandoned sign-in. Not the reverse - Privy does not share login state
  // between tabs, so ending Firebase whenever this tab's Privy looks signed out
  // would sign every other tab out as well.
  const privySignedIn = wallet.authenticated;
  useEffect(() => {
    if (!authResolved || verifiedAddress || status === "verifying" || ending.current) return;
    if (privySignedIn) logoutOfPrivy();
  }, [authResolved, verifiedAddress, status, privySignedIn, logoutOfPrivy]);

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
      signOutReason,
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
      isSigningOut: signingOut,
      // Set only between Privy's modal closing and the sign-in finishing.
      signInStep: status === "verifying" || status === "checking" ? signInStep : null,
      signIn,
      completeOnboarding,
      saveProfile,
      cancelOnboarding: signOutOfSession,
      signOut: signOutOfSession,
    }),
    [status, profile, error, signOutReason, verifiedAddress, authResolved, signingOut, signInStep, signIn, completeOnboarding,
      saveProfile, signOutOfSession],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside a SessionProvider");
  return context;
}

/**
 * Sign-in for a component that needs the member's wallet: the same flow as the
 * header button, with a failure handed to `onError` so it shows where the
 * member is looking. Outside a SessionProvider (an isolated component test)
 * there is no session to sign in to, so it does nothing.
 */
export function useSignIn(onError) {
  const signIn = useContext(SessionContext)?.signIn;
  const report = useRef(onError);
  report.current = onError;
  return useCallback(async () => {
    if (!signIn) return { ok: false };
    const result = await signIn();
    if (result.message) report.current?.(result.message);
    return result;
  }, [signIn]);
}
