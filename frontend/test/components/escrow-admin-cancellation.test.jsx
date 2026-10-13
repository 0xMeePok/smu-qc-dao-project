import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const mocks = vi.hoisted(() => ({ read: vi.fn(), start: vi.fn(), auth: { user: { id: `0x${"a".repeat(40)}` }, hasRole: () => true } }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => mocks.auth }));
vi.mock("../../src/lib/escrowAdmin.js", () => ({ getEscrowAdminCancellation: mocks.read, startEscrowAdminCancellation: mocks.start }));
vi.mock("../../src/lib/escrow.js", () => ({ escrowErrorMessage: err => err.message }));
import { AdminEscrowCancellation } from "../../src/components/AdminEscrowCancellation.jsx";
const summary = { state: "Open", totalDeposited: "50000000", fundingTarget: "100000000", totalReleased: "0", totalRefunded: "0",
  outstandingBalance: "50000000", tokenSymbol: "USDC", tokenDecimals: 6, blockNumber: 100, timestamp: 1900000000,
  custodyLock: { status: "locked", verifiedAt: "1900000000", unlockAt: "2000000000", reason: "posting_window" } };
const initial = { proposalId: "proposal-1", title: "Routing", summary, canCancel: true, cancellation: null, request: null };
const hash = `0x${"1".repeat(64)}`;
beforeEach(() => {
  mocks.auth = { user: { id: `0x${"a".repeat(40)}` }, hasRole: () => true };
  mocks.read.mockReset().mockResolvedValue(initial); mocks.start.mockReset();
});
afterEach(cleanup);
it("does not read or expose cancellation controls to a non-administrator", () => {
  mocks.auth.hasRole = () => false;
  render(<AdminEscrowCancellation proposalId="proposal-1" />);
  expect(mocks.read).not.toHaveBeenCalled(); expect(screen.queryByText("Cancel escrow")).toBeNull();
});
it("requires a reason and confirmation before submitting a durable request", async () => {
  mocks.start.mockResolvedValue({ cancellation: { id: "request-1", status: "queued", reason: "Created in error" }, canCancel: false });
  render(<AdminEscrowCancellation proposalId="proposal-1" />);
  const reason = await screen.findByLabelText("Cancellation reason");
  await waitFor(() => expect(reason.disabled).toBe(false));
  const cancel = screen.getByRole("button", { name: "Cancel escrow", exact: true });
  expect(cancel.disabled).toBe(true);
  fireEvent.change(reason, { target: { value: "Created in error" } }); fireEvent.click(cancel);
  expect(mocks.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
  await screen.findByText("Cancellation is pending confirmation. Funds have not been refunded.");
  expect(mocks.start).toHaveBeenCalledWith({ proposalId: "proposal-1", reason: "Created in error", requestId: expect.any(String) });
  expect(screen.queryByText(/Cancellation confirmed/)).toBeNull();
});
it("prevents manual cancellation after a payment has been released", async () => {
  mocks.read.mockResolvedValue({ ...initial, canCancel: false, blockReason: "Escrow cannot be cancelled after any payment has been released.", summary: { ...summary, state: "Active", totalReleased: "25000000" } });
  render(<AdminEscrowCancellation proposalId="proposal-1" />);
  await screen.findByText(/Escrow cannot be cancelled after any payment/);
  expect(screen.getByRole("button", { name: "Cancel escrow", exact: true }).disabled).toBe(true);
  expect(mocks.start).not.toHaveBeenCalled();
});
it("refreshes a pending request into a confirmed receipt and invalidates funding once", async () => {
  const pending = { id: "request-1", status: "pending", reason: "Created in error", transactionHash: hash };
  mocks.read.mockResolvedValueOnce({ ...initial, canCancel: false, cancellation: pending }).mockResolvedValue({ ...initial, canCancel: false,
    cancellation: { ...pending, status: "complete" }, summary: { ...summary, state: "Voided" } });
  const onConfirmed = vi.fn(); render(<AdminEscrowCancellation proposalId="proposal-1" onConfirmed={onConfirmed} />);
  await screen.findByText("Cancellation is pending confirmation. Funds have not been refunded.");
  expect(onConfirmed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh cancellation" }));
  await screen.findByText("Cancellation confirmed. Refunds are available to claim.");
  expect(onConfirmed).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("link", { name: "Anchored cancellation receipt" }).getAttribute("href")).toBe(`https://sepolia.arbiscan.io/tx/${hash}#eventlog`);
  fireEvent.click(screen.getByRole("button", { name: "Refresh cancellation" }));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(3));
  expect(onConfirmed).toHaveBeenCalledTimes(1);
});
it("does not show a successful refund when the request or chain confirmation failed", async () => {
  mocks.read.mockRejectedValue(new Error("RPC unavailable"));
  render(<AdminEscrowCancellation proposalId="proposal-1" />);
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Cancel escrow", exact: true }).disabled).toBe(true);
  expect(screen.queryByText(/Cancellation confirmed/)).toBeNull();
});
