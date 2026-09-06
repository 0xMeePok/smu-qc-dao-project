import React, { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: { currentUser: null },
  authListener: null,
  profileListener: null,
  accountAddress: null,
  disconnect: vi.fn(async () => {}),
  go: vi.fn(),
  revoke: vi.fn(async () => ({ success: true })),
  signOut: vi.fn(),
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: mocks.accountAddress }),
  useDisconnect: () => ({ disconnectAsync: mocks.disconnect }),
  useSignMessage: () => ({ signMessageAsync: vi.fn() }),
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
  onSnapshot: (_ref, callback) => {
    mocks.profileListener = callback;
    callback({ exists: () => true, data: () => ({ fullName: "Ada", role: 0 }) });
    return () => {};
  },
}));
vi.mock("../../src/lib/firebase.js", () => ({
  auth: mocks.auth,
  db: {},
  isFirebaseConfigured: true,
}));
vi.mock("../../src/lib/authFlow.js", () => ({
  exchangeSignatureForSession: vi.fn(),
  requestSignInMessage: vi.fn(),
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
  });

  afterEach(() => cleanup());

  it("restores the persisted Firebase user through the actual provider", async () => {
    mountProvider();
    await waitFor(() => expect(currentSession?.isSignedIn).toBe(true));
    expect(currentSession.address).toBe(mocks.auth.currentUser.uid);
    expect(currentSession.profile.fullName).toBe("Ada");
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
