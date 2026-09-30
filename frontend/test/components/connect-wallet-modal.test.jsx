import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNT = `0x${"a".repeat(40)}`;
const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  signIn: vi.fn(),
  callbacks: {},
  authenticated: false,
  user: null,
}));

vi.mock("@privy-io/react-auth", () => ({
  useLogin: (callbacks) => {
    mocks.callbacks = callbacks;
    return { login: mocks.login };
  },
  usePrivy: () => ({
    authenticated: mocks.authenticated,
    user: mocks.user,
  }),
}));
vi.mock("../../src/context/SessionContext.jsx", () => ({
  useSession: () => ({ signIn: mocks.signIn }),
}));
vi.mock("../../src/lib/privy.js", () => ({
  privyAppId: "test-app",
  ethereumAddressFromPrivyUser: (user) => user.wallet.address,
}));

const { ConnectWalletModal } = await import("../../src/components/ConnectWalletModal.jsx");

describe("ConnectWalletModal", () => {
  beforeEach(() => {
    mocks.login.mockReset();
    mocks.signIn.mockReset();
    mocks.callbacks = {};
    mocks.authenticated = false;
    mocks.user = null;
    mocks.login.mockImplementation(() => {
      // The Privy modal resolves later; the test drives that callback.
    });
  });

  afterEach(cleanup);

  it("shows connection and authorization as separate steps", async () => {
    let finishSignIn;
    mocks.signIn.mockImplementation(() => new Promise((resolve) => {
      finishSignIn = resolve;
    }));

    const onClose = vi.fn();
    render(<ConnectWalletModal onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /Continue with Privy/ }));
    expect(await screen.findByText("Connecting…")).toBeTruthy();
    expect(mocks.login).toHaveBeenCalledOnce();

    act(() => {
      mocks.callbacks.onComplete({ user: { wallet: { address: ACCOUNT } } });
    });
    expect(await screen.findByText("Authorising…")).toBeTruthy();

    await act(async () => finishSignIn({ ok: true, rejected: false }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("continues an existing Privy session instead of calling login again", async () => {
    mocks.authenticated = true;
    mocks.user = { wallet: { address: ACCOUNT } };
    mocks.signIn.mockResolvedValue({ ok: true, rejected: false });

    const onClose = vi.fn();
    render(<ConnectWalletModal onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /Continue with Privy/ }));

    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.signIn).toHaveBeenCalledWith(ACCOUNT);
    await act(async () => {});
    expect(onClose).toHaveBeenCalledOnce();
  });
});
