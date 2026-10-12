import React, { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: { currentUser: null },
  authListener: null,
  profileListener: null,
  profileError: null,
  subscribeProfile: vi.fn(),
  accountAddress: null,
  disconnect: vi.fn(async () => {}),
  go: vi.fn(),
  revoke: vi.fn(async () => ({ success: true })),
  signOut: vi.fn(),
  requestMessage: vi.fn(),
  signMessage: vi.fn(),
  exchangeSignature: vi.fn(),
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: mocks.accountAddress }),
  useDisconnect: () => ({ disconnectAsync: mocks.disconnect }),
  useSignMessage: () => ({ signMessageAsync: mocks.signMessage }),
}));
vi.mock("wagmi/actions", () => ({
  getConnection: () => ({ chainId: 421614 }),
  switchChain: vi.fn(),
}));
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
  onSnapshot: (_ref, callback, onError) => {
    mocks.profileListener = callback;
    mocks.profileError = onError;
    return mocks.subscribeProfile(callback, onError);
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
vi.mock("../../src/lib/wagmi.js", () => ({ wagmiConfig: {} }));
vi.mock("../../src/lib/router.js", () => ({ go: (...args) => mocks.go(...args) }));
vi.mock("../../src/lib/idleTimeout.js", () => ({
  IDLE_CHECK_INTERVAL_MS: 60_000,
  clearActivity: vi.fn(),
  hasActivityRecord: () => true,
  isIdleExpired: () => false,
  markActivity: vi.fn(),
}));

import { SessionProvider, useSession } from "../../src/context/SessionContext.jsx";

let currentSession;
function Probe() {
  const session = useSession();
  useEffect(() => { currentSession = session; }, [session]);
  return <div data-testid="status">{session.status}</div>;
}

function mountProvider() {
  return render(<SessionProvider><Probe /></SessionProvider>);
}

describe("SessionProvider persistence and logout integration", () => {
  beforeEach(() => {
    currentSession = null;
    mocks.accountAddress = null;
    mocks.auth.currentUser = { uid: `0x${"a".repeat(40)}` };
    mocks.signOut.mockImplementation(async () => {
      mocks.auth.currentUser = null;
      mocks.authListener?.(null);
    });
    mocks.revoke.mockResolvedValue({ success: true });
    mocks.subscribeProfile.mockImplementation(callback => {
      callback({ exists: () => true, data: () => ({ fullName: "Ada", role: 0 }) });
      return () => {};
    });
  });

  afterEach(() => cleanup());

  it("restores the persisted Firebase user through the actual provider", async () => {
    mountProvider();
    await waitFor(() => expect(currentSession?.isSignedIn).toBe(true));
    expect(currentSession.address).toBe(mocks.auth.currentUser.uid);
    expect(currentSession.profile.fullName).toBe("Ada");
  });

  it("only asks for a wallet signature after the server challenge is ready", async () => {
    mocks.auth.currentUser = null;
    mocks.accountAddress = `0x${"a".repeat(40)}`;
    let nonceReady, signatureReady, sessionReady;
    mocks.requestMessage.mockReturnValue(new Promise(resolve => { nonceReady = resolve; }));
    mocks.signMessage.mockReturnValue(new Promise(resolve => { signatureReady = resolve; }));
    mocks.exchangeSignature.mockReturnValue(new Promise(resolve => { sessionReady = resolve; }));
    mountProvider();
    await waitFor(() => expect(currentSession?.isLoading).toBe(false));

    let pending;
    act(() => { pending = currentSession.signIn(); });
    expect(currentSession.signInPhase).toBe("preparing");
    expect(currentSession.isBusy).toBe(true);
    expect(mocks.signMessage).not.toHaveBeenCalled();

    await act(async () => { nonceReady({ message: "Sign in", challengeId: "nonce" }); });
    expect(currentSession.signInPhase).toBe("signing");
    expect(mocks.signMessage).toHaveBeenCalledOnce();
    await act(async () => { signatureReady("signature"); });
    expect(currentSession.signInPhase).toBe("checking");
    await act(async () => { sessionReady(); await pending; });
    expect(currentSession.signInPhase).toBeNull();
    expect(currentSession.isSignedIn).toBe(true);
  });

  it("recovers a failed profile listener when the same wallet signs in again without an auth-state event", async () => {
    mocks.accountAddress = mocks.auth.currentUser.uid;
    const unsubscribe = vi.fn();
    mocks.subscribeProfile.mockImplementationOnce((_next, error) => {
      error({ code: "permission-denied" });
      return unsubscribe;
    });
    // Firebase need not notify onAuthStateChanged when the UID stays the same.
    mocks.requestMessage.mockResolvedValue({ message: "Sign in", challengeId: "retry" });
    mocks.signMessage.mockResolvedValue("signature");
    mocks.exchangeSignature.mockResolvedValue(mocks.accountAddress);
    mountProvider();
    await waitFor(() => expect(currentSession?.error).toBeTruthy());
    expect(currentSession.isSignedIn).toBe(false);

    // A valid signature alone must not grant access: wait for the fresh profile.
    mocks.subscribeProfile.mockImplementation(() => () => {});
    await act(async () => { expect((await currentSession.signIn()).ok).toBe(true); });
    expect(currentSession.isChecking).toBe(true);
    expect(currentSession.isSignedIn).toBe(false);
    expect(currentSession.signInPhase).toBeNull();
    expect(unsubscribe).toHaveBeenCalledOnce();
    await act(async () => {
      mocks.profileListener({ exists: () => true, data: () => ({ fullName: "Ada", role: 0 }) });
    });
    expect(currentSession.isSignedIn).toBe(true);
    expect(currentSession.isBusy).toBe(false);
    expect(currentSession.error).toBeNull();
  });

  it("continues to deny access if the refreshed same-wallet profile read is rejected", async () => {
    mocks.accountAddress = mocks.auth.currentUser.uid;
    mocks.subscribeProfile.mockImplementation((_next, error) => {
      error({ code: "permission-denied" });
      return () => {};
    });
    mocks.requestMessage.mockResolvedValue({ message: "Sign in", challengeId: "retry" });
    mocks.signMessage.mockResolvedValue("signature");
    mocks.exchangeSignature.mockResolvedValue(mocks.accountAddress);
    mountProvider();
    await waitFor(() => expect(currentSession?.error).toBeTruthy());

    await act(async () => { await currentSession.signIn(); });
    expect(currentSession.isSignedIn).toBe(false);
    expect(currentSession.isBusy).toBe(false);
    expect(currentSession.error).toBeTruthy();
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
    expect(mocks.go).toHaveBeenCalledWith("login");
  });

  it("keeps the session visible when server revocation itself fails", async () => {
    mountProvider();
    await waitFor(() => expect(currentSession?.isSignedIn).toBe(true));
    mocks.revoke.mockRejectedValueOnce(new Error("revocation failed"));

    let result;
    await act(async () => { result = await currentSession.signOut(); });

    expect(result.ok).toBe(false);
    expect(currentSession.isSignedIn).toBe(true);
    expect(currentSession.error).toContain("revocation failed");
    expect(mocks.disconnect).not.toHaveBeenCalled();
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

  it("keeps the session visible when a wallet switch cannot clear Firebase persistence", async () => {
    const view = mountProvider();
    await waitFor(() => expect(currentSession?.isSignedIn).toBe(true));
    mocks.signOut.mockRejectedValueOnce(new Error("persistence removal failed"));

    mocks.accountAddress = `0x${"b".repeat(40)}`;
    view.rerender(<SessionProvider><Probe /></SessionProvider>);

    await waitFor(() => expect(currentSession?.error).toContain("persistence removal failed"));
    expect(currentSession.isSignedIn).toBe(true);
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(mocks.go).not.toHaveBeenCalledWith("login");
  });

  it("clears the session after a wallet switch once Firebase sign-out succeeds", async () => {
    const view = mountProvider();
    await waitFor(() => expect(currentSession?.isSignedIn).toBe(true));

    mocks.accountAddress = `0x${"b".repeat(40)}`;
    view.rerender(<SessionProvider><Probe /></SessionProvider>);

    await waitFor(() => expect(currentSession?.isSignedIn).toBe(false));
    expect(mocks.signOut).toHaveBeenCalled();
    expect(currentSession.address).toBeNull();
  });
});
