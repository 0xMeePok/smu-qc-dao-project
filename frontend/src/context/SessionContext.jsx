import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useDisconnect, useSignMessage } from "wagmi";
import { getConnection, switchChain } from "wagmi/actions";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth, isFirebaseConfigured } from "../lib/firebase.js";
import { exchangeSignatureForSession, requestSignInMessage } from "../lib/authFlow.js";
import { createProfile, findProfileByAddress } from "../lib/profile.js";
import { messageForFirebaseError } from "../lib/errors.js";
import { EXPECTED_CHAIN_ID, EXPECTED_CHAIN_NAME } from "../lib/chain.js";
import { wagmiConfig } from "../lib/wagmi.js";
import { isAdmin } from "../lib/roles.js";
import { go } from "../lib/router.js";

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
        // Trade-off: if the user dismisses the switch prompt, a nonce may already have
        // been issued and left pending - their very next retry can hit the 3-second
        // per-address cooldown in getSiweNonce (see NONCE_COOLDOWN_MS) instead of
        // going straight through. That's a rare edge case costing a few seconds, in
        // exchange for the common case (switch approved, or already on the right
        // chain) reaching the signing prompt measurably sooner every time.
        const needsSwitch = getConnection(wagmiConfig).chainId !== EXPECTED_CHAIN_ID;
        const [message] = await Promise.all([
          requestSignInMessage(target),
          needsSwitch ? switchChain(wagmiConfig, { chainId: EXPECTED_CHAIN_ID }) : null,
        ]);

        const signature = await signMessageAsync({ message, account: target });
        await exchangeSignatureForSession({ address: target, signature });
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
        await disconnectAsync().catch(() => {});
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

    (async () => {
      try {
        const found = await findProfileByAddress(verifiedAddress);
        if (token !== lookupToken.current) return;
        setProfile(found);
        setStatus(found ? "signed-in" : "needs-onboarding");
        // Fires once per session establishment (this effect only re-runs when
        // verifiedAddress changes - a fresh sign-in or a restored session on page
        // load), not on every render, so navigating elsewhere afterward doesn't
        // keep yanking an admin back here.
        if (found && isAdmin(found.role)) go("admin");
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
    }),
    [status, profile, error, verifiedAddress, signIn, completeOnboarding, signOutOfSession],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside a SessionProvider");
  return context;
}
