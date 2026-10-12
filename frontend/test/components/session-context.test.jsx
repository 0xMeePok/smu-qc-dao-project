import React, { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ADDRESS = `0x${"a".repeat(40)}`;

const mocks = vi.hoisted(() => ({
  auth: { currentUser: null },
  authListener: null,
  profile: null,
  idleExpired: false,
  wallet: null,
  go: vi.fn(),
  revoke: vi.fn(async () => ({ success: true })),
  signOut: vi.fn(),
  requestMessage: vi.fn(),
  exchangeSignature: vi.fn(),
}));

vi.mock("../../src/context/WalletContext.jsx", () => ({ useWallet: () => mocks.wallet }));
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_auth, callback) => {
    mocks.authListener = callback;
    queueMicrotask(() => callback(mocks.auth.currentUser));
    return () => {};
  },
  signOut: (...args) => mocks.signOut(...args),
}));
vi.mock("firebase/firestore", () => ({
  doc: (_db, collection, id) => ({ collection, id }),
  onSnapshot: (_ref, callback) => {
    callback({ exists: () => Boolean(mocks.profile), data: () => mocks.profile });
    return () => {};
  },
}));
vi.mock("../../src/lib/firebase.js", () => ({
  auth: mocks.auth,
  db: {},
  isFirebaseConfigured: true,
}));
vi.mock("../../src/lib/authFlow.js", () => ({
  exchangeSignatureForSession: (...args) => mocks.exchangeSignature(...args),
  requestSignInMessage: (...args) => mocks.requestMessage(...args),
  revokeOwnSessions: (...args) => mocks.revoke(...args),
}));
vi.mock("../../src/lib/profile.js", () => ({
  createProfile: vi.fn(),
  findProfileByAddress: vi.fn(),
  updateProfile: vi.fn(),
}));
vi.mock("../../src/lib/router.js", () => ({ go: (...args) => mocks.go(...args) }));
vi.mock("../../src/lib/idleTimeout.js", () => ({
  IDLE_CHECK_INTERVAL_MS: 60_000,
  clearActivity: vi.fn(),
  hasActivityRecord: () => true,
  isIdleExpired: () => mocks.idleExpired,
  markActivity: vi.fn(),
}));

import { SessionProvider, useSession } from "../../src/context/SessionContext.jsx";
import { SignInWithEmail } from "../../src/components/SignInWithEmail.jsx";
import { ACCOUNT_SUSPENDED_MESSAGE } from "../../src/lib/errors.js";

let currentSession;
function Probe() {
  const session = useSession();
  useEffect(() => { currentSession = session; }, [session]);
  return <div data-testid="status">{session.status}</div>;
}

function mountProvider() {
  return render(<SessionProvider><Probe /></SessionProvider>);
}

// The WalletContext as SessionProvider sees it. `login` stands for Privy's
// login modal finishing; `logout` for Privy ending its session.
function privyWallet(overrides = {}) {
  const wallet = {
    configured: true,
    ready: true,
    authenticated: false,
    address: null,
    isConnected: false,
    chainId: undefined,
    login: vi.fn(async () => { wallet.authenticated = true; }),
    ensureWallet: vi.fn(async () => ADDRESS),
    signMessage: vi.fn(async () => "0xsignature"),
    logout: vi.fn(async () => { wallet.authenticated = false; }),
    ...overrides,
  };
  return wallet;
}

const privyError = (privyErrorCode, message = privyErrorCode) => Object.assign(new Error(message), { privyErrorCode });
const suspendedError = () => Object.assign(
  new Error("This account has been suspended by an administrator."), { code: "functions/permission-denied" },
);

describe("SessionProvider: Privy email sign-in and session lockstep", () => {
  beforeEach(() => {
    currentSession = null;
    mocks.wallet = privyWallet();
    mocks.profile = { fullName: "Ada", role: 0 };
    mocks.idleExpired = false;
    mocks.go.mockReset();
    mocks.auth.currentUser = { uid: ADDRESS };
    mocks.signOut.mockReset().mockImplementation(async () => {
      mocks.auth.currentUser = null;
      mocks.authListener?.(null);
    });
    mocks.revoke.mockReset().mockResolvedValue({ success: true });
    mocks.requestMessage.mockReset().mockResolvedValue({ message: "Sign in", challengeId: "nonce" });
    mocks.exchangeSignature.mockReset().mockResolvedValue(ADDRESS);
  });

  afterEach(() => cleanup());

  it("restores the persisted Firebase user through the actual provider", async () => {
    mountProvider();
    await waitFor(() => expect(currentSession?.isSignedIn).toBe(true));
    expect(currentSession.address).toBe(mocks.auth.currentUser.uid);
    expect(currentSession.profile.fullName).toBe("Ada");
  });

  it("opens Privy's login modal, then has the embedded wallet sign the server challenge", async () => {
    mocks.auth.currentUser = null;
    const mixedCase = `0x${"A".repeat(40)}`;
    let loggedIn, walletReady, nonceReady, signatureReady, sessionReady;
    mocks.wallet.login.mockReturnValue(new Promise(resolve => { loggedIn = resolve; }));
    mocks.wallet.ensureWallet.mockReturnValue(new Promise(resolve => { walletReady = resolve; }));
    mocks.requestMessage.mockReturnValue(new Promise(resolve => { nonceReady = resolve; }));
    mocks.wallet.signMessage.mockReturnValue(new Promise(resolve => { signatureReady = resolve; }));
    mocks.exchangeSignature.mockReturnValue(new Promise(resolve => { sessionReady = resolve; }));
    mountProvider();
    await waitFor(() => expect(currentSession?.isLoading).toBe(false));

    let pending;
    act(() => { pending = currentSession.signIn(); });
    // Privy's modal is open: email, code and (first time) the wallet are its job.
    expect(mocks.wallet.login).toHaveBeenCalledOnce();
    expect(currentSession.isVerifying).toBe(true);
    expect(mocks.wallet.ensureWallet).not.toHaveBeenCalled();

    await act(async () => { loggedIn(); });
    expect(mocks.wallet.ensureWallet).toHaveBeenCalledOnce();
    expect(mocks.requestMessage).not.toHaveBeenCalled();

    await act(async () => { walletReady(mixedCase); });
    expect(mocks.requestMessage).toHaveBeenCalledExactlyOnceWith(ADDRESS);
    expect(mocks.wallet.signMessage).not.toHaveBeenCalled();

    await act(async () => { nonceReady({ message: "Sign in", challengeId: "nonce" }); });
    expect(mocks.wallet.signMessage).toHaveBeenCalledExactlyOnceWith("Sign in", ADDRESS);

    await act(async () => { signatureReady("0xsignature"); });
    expect(mocks.exchangeSignature).toHaveBeenCalledExactlyOnceWith({
      address: ADDRESS, signature: "0xsignature", challengeId: "nonce",
    });

    let outcome;
    await act(async () => { sessionReady(ADDRESS); outcome = await pending; });
    expect(outcome).toEqual({ ok: true });
    expect(currentSession.isSignedIn).toBe(true);
    expect(currentSession.address).toBe(ADDRESS);
    expect(mocks.wallet.logout).not.toHaveBeenCalled();
  });

  it("runs onboarding after a first email sign-in", async () => {
    mocks.auth.currentUser = null;
    mocks.profile = null;
    mountProvider();
    await waitFor(() => expect(currentSession?.isLoading).toBe(false));
    await act(async () => { await currentSession.signIn(); });
    expect(currentSession.needsOnboarding).toBe(true);
    expect(currentSession.address).toBe(ADDRESS);
  });

  it("treats a closed Privy modal as a change of mind, not an error", async () => {
    mocks.auth.currentUser = null;
    mocks.wallet.login.mockRejectedValueOnce(privyError("exited_auth_flow", "Sign-in was cancelled."));
    mountProvider();
    await waitFor(() => expect(currentSession?.isLoading).toBe(false));

    let outcome;
    await act(async () => { outcome = await currentSession.signIn(); });
    expect(outcome).toEqual({ ok: false, cancelled: true });
    expect(currentSession.error).toBeNull();
    expect(currentSession.status).toBe("signed-out");
    expect(mocks.wallet.ensureWallet).not.toHaveBeenCalled();
    expect(mocks.wallet.logout).not.toHaveBeenCalled();
  });

  it("runs one sign-in at a time, however many buttons ask for one", async () => {
    mocks.auth.currentUser = null;
    let loggedIn;
    mocks.wallet.login.mockReturnValue(new Promise(resolve => { loggedIn = resolve; }));
    mountProvider();
    await waitFor(() => expect(currentSession?.isLoading).toBe(false));

    let first, second;
    act(() => { first = currentSession.signIn(); second = currentSession.signIn(); });
    expect(second).toBe(first);
    expect(mocks.wallet.login).toHaveBeenCalledOnce();
    await act(async () => { loggedIn(); await first; });
  });

  it("keeps a signed-in member's session while Privy's modal is open, and does not re-sign for the same account", async () => {
    let loggedIn;
    mocks.wallet.login.mockReturnValue(new Promise(resolve => { loggedIn = resolve; }));
    mountProvider();
    await waitFor(() => expect(currentSession?.isSignedIn).toBe(true));

    let pending;
    act(() => { pending = currentSession.signIn(); });
    expect(mocks.wallet.login).toHaveBeenCalledOnce();
    expect(currentSession.isSignedIn).toBe(true);

    let outcome;
    await act(async () => { loggedIn(); outcome = await pending; });
    expect(outcome).toEqual({ ok: true });
    expect(mocks.wallet.ensureWallet).toHaveBeenCalledOnce();
    expect(mocks.requestMessage).not.toHaveBeenCalled();
    expect(mocks.exchangeSignature).not.toHaveBeenCalled();
    expect(currentSession.isSignedIn).toBe(true);
  });

  it("ends the Privy session when the Firebase exchange refuses the sign-in", async () => {
    mocks.auth.currentUser = null;
    mocks.exchangeSignature.mockRejectedValueOnce(suspendedError());
    mountProvider();
    await waitFor(() => expect(currentSession?.isLoading).toBe(false));

    let outcome;
    await act(async () => { outcome = await currentSession.signIn(); });
    expect(outcome).toEqual({ ok: false, message: ACCOUNT_SUSPENDED_MESSAGE });
    expect(currentSession.isSignedIn).toBe(false);
    expect(currentSession.error).toBe(ACCOUNT_SUSPENDED_MESSAGE);
    expect(mocks.wallet.logout).toHaveBeenCalledOnce();
  });

  it("signs in from the header button and explains a failure beside it", async () => {
    mocks.auth.currentUser = null;
    mocks.exchangeSignature.mockRejectedValueOnce(suspendedError());
    render(<SessionProvider><SignInWithEmail /></SessionProvider>);

    const button = await screen.findByRole("button", { name: "Sign in with email" });
    await act(async () => { fireEvent.click(button); });
    expect(mocks.wallet.login).toHaveBeenCalledOnce();
    expect((await screen.findByRole("alert")).textContent).toBe(ACCOUNT_SUSPENDED_MESSAGE);
  });

  it("signs out of the server, Firebase and Privy, in that order", async () => {
    mountProvider();
    await waitFor(() => expect(currentSession?.isSignedIn).toBe(true));

    let result;
    await act(async () => { result = await currentSession.signOut(); });
    expect(result.ok).toBe(true);
    await waitFor(() => expect(currentSession.isSignedIn).toBe(false));
    expect(mocks.revoke.mock.invocationCallOrder[0]).toBeLessThan(mocks.signOut.mock.invocationCallOrder[0]);
    expect(mocks.signOut.mock.invocationCallOrder[0]).toBeLessThan(mocks.wallet.logout.mock.invocationCallOrder[0]);
    expect(mocks.go).toHaveBeenCalledWith("login");
  });

  // Revocation already succeeded here, so the token is dead server-side. Staying
  // "signed in" would leave the app using credentials every rule refuses, which
  // surfaces as unexplained 403s on the next upload or download.
  it("signs out locally even when Firebase sign-out fails, since the token is already revoked", async () => {
    mountProvider();
    await waitFor(() => expect(currentSession?.isSignedIn).toBe(true));
    mocks.signOut.mockRejectedValueOnce(new Error("persistence removal failed"));

    let result;
    await act(async () => { result = await currentSession.signOut(); });

    expect(result.ok).toBe(true);
    await waitFor(() => expect(currentSession.isSignedIn).toBe(false));
    expect(mocks.revoke).toHaveBeenCalledOnce();
    expect(mocks.wallet.logout).toHaveBeenCalledOnce();
    expect(mocks.go).toHaveBeenCalledWith("login");
  });

  it("keeps both sessions when server revocation itself fails", async () => {
    mountProvider();
    await waitFor(() => expect(currentSession?.isSignedIn).toBe(true));
    mocks.revoke.mockRejectedValueOnce(new Error("revocation failed"));

    let result;
    await act(async () => { result = await currentSession.signOut(); });

    expect(result.ok).toBe(false);
    expect(currentSession.isSignedIn).toBe(true);
    expect(currentSession.error).toContain("revocation failed");
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.wallet.logout).not.toHaveBeenCalled();
    expect(mocks.go).not.toHaveBeenCalledWith("login");
  });

  it("revokes server credentials, clears persistence, and stays signed out after reload", async () => {
    const first = mountProvider();
    await waitFor(() => expect(currentSession?.isSignedIn).toBe(true));

    await act(async () => { await currentSession.signOut(); });
    await waitFor(() => expect(currentSession?.isSignedIn).toBe(false));
    expect(mocks.revoke).toHaveBeenCalledOnce();
    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.go).toHaveBeenCalledWith("login");

    first.unmount();
    currentSession = null;
    mountProvider();
    await waitFor(() => expect(currentSession?.isLoading).toBe(false));
    expect(currentSession.isSignedIn).toBe(false);
    expect(currentSession.address).toBeNull();
  });

  it("ends both sessions after the idle timeout", async () => {
    mocks.idleExpired = true;
    mountProvider();
    await waitFor(() => expect(mocks.wallet.logout).toHaveBeenCalledOnce());
    await waitFor(() => expect(currentSession?.error).toMatch(/15 minutes of inactivity/));
    expect(currentSession.isSignedIn).toBe(false);
    expect(mocks.revoke).toHaveBeenCalledOnce();
    expect(mocks.signOut).toHaveBeenCalledOnce();
  });

  it("ends both sessions when the account is suspended, without calling back in as it", async () => {
    mocks.profile = { fullName: "Ada", role: 0, suspended: true };
    mountProvider();
    await waitFor(() => expect(mocks.wallet.logout).toHaveBeenCalledOnce());
    await waitFor(() => expect(currentSession?.error).toBe(ACCOUNT_SUSPENDED_MESSAGE));
    expect(currentSession.isSignedIn).toBe(false);
    expect(currentSession.address).toBeNull();
    expect(mocks.signOut).toHaveBeenCalledOnce();
    // setUserSuspension already revoked the account's tokens server side.
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("ends a Privy session that has no Firebase session beside it", async () => {
    mocks.auth.currentUser = null;
    mocks.wallet = privyWallet({ authenticated: true, address: ADDRESS, isConnected: true });
    mountProvider();
    await waitFor(() => expect(mocks.wallet.logout).toHaveBeenCalledOnce());
    expect(currentSession.isSignedIn).toBe(false);
  });

  it("keeps the Privy session that belongs to a restored Firebase session", async () => {
    mocks.wallet = privyWallet({ authenticated: true, address: ADDRESS, isConnected: true });
    mountProvider();
    await waitFor(() => expect(currentSession?.isSignedIn).toBe(true));
    expect(mocks.wallet.logout).not.toHaveBeenCalled();
  });
});
