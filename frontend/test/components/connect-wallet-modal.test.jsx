import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNT = `0x${"a".repeat(40)}`;
const mocks = vi.hoisted(() => ({
  connector: { id: "io.metamask", uid: "metamask-1", name: "MetaMask" },
  connect: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock("wagmi", () => ({
  useConnect: () => ({ connectors: [mocks.connector], connectAsync: mocks.connect }),
}));
vi.mock("../../src/context/SessionContext.jsx", () => ({
  useSession: () => ({ signIn: mocks.signIn }),
}));
vi.mock("../../src/lib/wagmi.js", () => ({
  isUsableConnector: () => true,
}));

const { ConnectWalletModal } = await import("../../src/components/ConnectWalletModal.jsx");

describe("ConnectWalletModal", () => {
  beforeEach(() => {
    mocks.connect.mockReset();
    mocks.signIn.mockReset();
  });

  afterEach(cleanup);

  it("shows connection and authorization as separate steps", async () => {
    let finishConnect;
    let finishSignIn;
    mocks.connect.mockImplementation(() => new Promise((resolve) => {
      finishConnect = resolve;
    }));
    mocks.signIn.mockImplementation(() => new Promise((resolve) => {
      finishSignIn = resolve;
    }));

    const onClose = vi.fn();
    render(<ConnectWalletModal onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /MetaMask/ }));
    expect(await screen.findByText("Connecting…")).toBeTruthy();

    await act(async () => finishConnect({ accounts: [ACCOUNT] }));
    expect(await screen.findByText("Authorising…")).toBeTruthy();

    await act(async () => finishSignIn({ ok: true, rejected: false }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
