import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), sync: vi.fn(), confirm: vi.fn(), supported: true, account: null, user: null }));
vi.mock("wagmi", () => ({ useAccount: () => mocks.account }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../src/lib/openFunding.js", () => ({ getOpenFundingSummary: (...args) => mocks.read(...args),
  writeOpenFundingAction: (...args) => mocks.write(...args), syncOpenFunding: (...args) => mocks.sync(...args), openFundingSupported: () => mocks.supported }));
vi.mock("../../src/lib/escrow.js", () => ({ confirmEscrowTransaction: (...args) => mocks.confirm(...args), escrowErrorMessage: error => error.message }));
vi.mock("../../src/components/ConnectWalletModal.jsx", () => ({ ConnectWalletModal: () => <p>Wallet connection dialog</p> }));
import { OpenFundingPanel, OpenFundingView } from "../../src/components/OpenFundingPanel.jsx";
const account = `0x${"a".repeat(40)}`, hash = `0x${"1".repeat(64)}`;
const proposal = { proposalId: "solution", title: "Quantum solution", amountBaseUnits: "50000000000", status: "none", canSelect: true };
const model = (extra = {}) => ({ supported: true, poolAddress: `0x${"b".repeat(40)}`, tokenAddress: `0x${"c".repeat(40)}`,
  tokenDecimals: 6, tokenSymbol: "USDC", totalDeposited: "100000000000", totalAllocated: "0", totalReserved: "0", available: "100000000000",
  canDeposit: true, canSelect: true, selections: [proposal], ...extra });
beforeEach(() => {
  sessionStorage.clear(); vi.clearAllMocks(); mocks.supported = true;
  mocks.account = { isConnected: true, address: account, chainId: 421614 }; mocks.user = { id: account };
  mocks.read.mockReset().mockResolvedValue(model()); mocks.sync.mockReset().mockResolvedValue({});
  mocks.write.mockReset().mockResolvedValue({ transactionHash: hash }); mocks.confirm.mockReset().mockResolvedValue({ transactionHash: hash });
});
afterEach(cleanup);
describe("open funding grant workflow UI", () => {
  it("routes grant selection through the grant API with a proposal reference", async () => {
    render(<OpenFundingPanel problemId="grant" />);
    fireEvent.click(await screen.findByRole("button", { name: "Select for funding" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ problemId: "grant", proposalId: "solution", action: "select", account })));
    expect(await screen.findByText("Offer recorded. The researcher has seven days to accept.")).toBeTruthy();
  });
  it("submits a top up using the current token's precision", async () => {
    render(<OpenFundingPanel problemId="grant" />);
    fireEvent.change(await screen.findByLabelText("Add funding"), { target: { value: "10000.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit funds" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ action: "deposit", amount: "10000.25", decimals: 6 })));
  });
  it.each([
    ["a researcher", { canWithdraw: false, closed: true }],
    ["a posting that is still open", { canWithdraw: true, closed: false }],
    ["a pool with no available funds", { canWithdraw: true, closed: true, available: "0" }],
  ])("hides owner withdrawals for %s", (_case, flags) => {
    render(<OpenFundingView data={model(flags)} amount="" walletReady />);
    expect(screen.queryByLabelText("Withdraw available funding")).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw funds" })).toBeNull();
  });
  it("validates the owner's withdrawal against unreserved funds and token precision", async () => {
    mocks.read.mockResolvedValue(model({ canWithdraw: true, closed: true, available: "10000250000" }));
    render(<OpenFundingPanel problemId="grant" />);
    const input = await screen.findByLabelText("Withdraw available funding");
    const button = screen.getByRole("button", { name: "Withdraw funds" });
    expect(button.disabled).toBe(true);
    for (const amount of ["0", "-1", "10000.250001", "1.0000001"]) {
      fireEvent.change(input, { target: { value: amount } });
      expect(button.disabled).toBe(true);
      expect(input.getAttribute("aria-invalid")).toBe("true");
    }
    expect(mocks.write).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "10000.25" } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({
      action: "withdraw", amount: "10000.25", decimals: 6, account, tokenAddress: model().tokenAddress,
    })));
    expect(await screen.findByText("Withdrawal confirmed. Unreserved funds have returned to your wallet.")).toBeTruthy();
  });
  it("requires the owner's connected wallet for withdrawals", () => {
    render(<OpenFundingView data={model({ canWithdraw: true, closed: true })} amount="" withdrawalAmount="1" walletReady={false} />);
    expect(screen.getByRole("button", { name: "Withdraw funds" }).disabled).toBe(true);
  });
  it("disables selection when existing reservations leave too little available", () => {
    render(<OpenFundingView data={model({ available: "49000000000", totalReserved: "51000000000" })} amount="" walletReady />);
    expect(screen.queryByRole("button", { name: "Select for funding" })).toBeNull();
    expect(screen.getByText("Deposit more funds to cover this request.")).toBeTruthy();
  });
  it("allows a researcher to accept their pending offer, and uses void cleanup for expired offers", () => {
    const action = vi.fn();
    const view = render(<OpenFundingView data={model({ canDeposit: false, selections: [{ ...proposal, status: "pending", canAccept: true }] })} amount="" walletReady onAction={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept grant" })); expect(action).toHaveBeenCalledWith("accept", "solution");
    view.rerender(<OpenFundingView data={model({ selections: [{ ...proposal, status: "expired", canVoid: true }] })} amount="" walletReady onAction={action} />);
    expect(screen.queryByRole("button", { name: "Accept grant" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Void expired offer" })); expect(action).toHaveBeenCalledWith("void", "solution");
  });
  it("fails closed with a clear deployment message and no grant read or write on the older deployment", async () => {
    mocks.supported = false; render(<OpenFundingPanel problemId="grant" />);
    expect(await screen.findByText(/current contract deployment/)).toBeTruthy(); expect(mocks.read).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Deposit funds" })).toBeNull();
  });
  it("checks a saved transaction instead of broadcasting another deposit", async () => {
    mocks.write.mockImplementation(async input => {
      input.onProgress({ status: "pending", transactionHash: hash, action: "deposit" }); throw new Error("Confirmation unavailable");
    });
    const view = render(<OpenFundingPanel problemId="grant" />);
    fireEvent.change(await screen.findByLabelText("Add funding"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit funds" }));
    await screen.findByRole("button", { name: "Check transaction" }); view.unmount();
    render(<OpenFundingPanel problemId="grant" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check transaction" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(hash, { confirmations: 2 }));
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
  it("recovers a pending withdrawal without broadcasting it again", async () => {
    mocks.read.mockResolvedValue(model({ canWithdraw: true, closed: true }));
    mocks.write.mockImplementation(async input => {
      input.onProgress({ status: "pending", transactionHash: hash, action: "withdrawAvailable" });
      throw new Error("Confirmation unavailable");
    });
    const view = render(<OpenFundingPanel problemId="withdrawal-grant" />);
    fireEvent.change(await screen.findByLabelText("Withdraw available funding"), { target: { value: "1.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw funds" }));
    await screen.findByRole("button", { name: "Check transaction" });
    expect(screen.getByRole("button", { name: "Withdraw funds" }).disabled).toBe(true);
    view.unmount();
    render(<OpenFundingPanel problemId="withdrawal-grant" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check transaction" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(hash, { confirmations: 2 }));
    expect(mocks.sync).toHaveBeenCalledWith(expect.objectContaining({ problemId: "withdrawal-grant", transactionHash: hash }));
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
  it("requires the signed-in wallet and configured network before signing", async () => {
    mocks.account.chainId = 1; render(<OpenFundingPanel problemId="grant" />);
    const button = await screen.findByRole("button", { name: "Select for funding" }); expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Connect your signed-in wallet" })); expect(screen.getByText("Wallet connection dialog")).toBeTruthy();
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
