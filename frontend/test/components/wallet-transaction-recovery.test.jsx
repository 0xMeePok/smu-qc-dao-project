import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const mocks = vi.hoisted(() => ({
  address: "0x1111111111111111111111111111111111111111",
  signedIn: true, pending: null, listener: null,
  recover: vi.fn(), unsubscribe: vi.fn(),
}));
vi.mock("../../src/context/SessionContext.jsx", () => ({ useSession: () => ({ isSignedIn: mocks.signedIn, address: mocks.address }) }));
vi.mock("../../src/context/WalletContext.jsx", () => ({ useWallet: () => ({ address: mocks.address }) }));
vi.mock("../../src/lib/embeddedWallet.js", () => ({
  getPendingSponsoredTransaction: () => mocks.pending,
  recoverPendingSponsoredTransaction: mocks.recover,
  subscribePendingSponsoredTransactions: (listener) => { mocks.listener = listener; return mocks.unsubscribe; },
}));
import { WalletTransactionRecovery } from "../../src/components/WalletTransactionRecovery.jsx";

describe("wallet transaction recovery", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.signedIn = true; mocks.pending = null; mocks.listener = null; });
  afterEach(cleanup);
  it("does not show another member's recovery while signed out", () => {
    mocks.signedIn = false;
    mocks.pending = { transactionHash: `0x${"a".repeat(64)}` };
    render(<WalletTransactionRecovery />);
    expect(screen.queryByRole("complementary")).toBeNull();
  });
  it("recovers a hashless operation without sending a new transaction", async () => {
    mocks.pending = { id: "pending", transactionHash: null };
    mocks.recover.mockImplementation(async () => { mocks.pending = null; return `0x${"a".repeat(64)}`; });
    render(<WalletTransactionRecovery />);
    fireEvent.click(screen.getByRole("button", { name: "Check wallet transaction" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Refresh the affected record"));
    expect(mocks.recover).toHaveBeenCalledWith({ wallet: { address: mocks.address }, timeoutMs: 10_000 });
    expect(screen.queryByRole("button", { name: "Check wallet transaction" })).toBeNull();
  });
  it("keeps recovery available after a provider outage", async () => {
    mocks.pending = { transactionHash: `0x${"b".repeat(64)}` };
    mocks.recover.mockRejectedValue(new Error("Your transaction is still pending."));
    render(<WalletTransactionRecovery />);
    fireEvent.click(screen.getByRole("button", { name: "Check wallet transaction" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("still pending"));
    expect(screen.getByRole("link", { name: "View pending wallet transaction" }).getAttribute("href")).toContain(mocks.pending.transactionHash);
    expect(screen.getByRole("button", { name: "Check wallet transaction" }).disabled).toBe(false);
  });
  it("cleans up the pending subscription on unmount", () => {
    const view = render(<WalletTransactionRecovery />);
    view.unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
