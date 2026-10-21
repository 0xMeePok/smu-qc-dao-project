import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import axe from "axe-core";
import { validateTokenTransfer, createFaucetClaim } from "../../src/lib/walletTokens.js";
const state = vi.hoisted(() => ({ wallet: null }));
vi.mock("../../src/context/WalletContext.jsx", () => ({ useWallet: () => state.wallet }));
vi.mock("../../src/lib/firebase.js", () => ({ functions: null }));
import { AccountWallet } from "../../src/components/AccountWallet.jsx";

const address = `0x${"a".repeat(40)}`;
const other = `0x${"b".repeat(40)}`;
const hash = `0x${"1".repeat(64)}`;
const initial = { XSGD: 1_000_000n, USDT: 2_000_000n, USDC: 5_000_000n };
let services;
beforeEach(() => {
  sessionStorage.clear(); localStorage.clear();
  state.wallet = { address, email: "own@example.com", isConnected: true, signMessage: vi.fn().mockResolvedValue(`0x${"2".repeat(130)}`) };
  services = {
    readWalletBalances: vi.fn().mockResolvedValue(initial), validateTokenTransfer, createFaucetClaim,
    sendWalletTokens: vi.fn().mockResolvedValue({ transactionHash: hash }),
    confirmWalletTokenTransfer: vi.fn().mockResolvedValue({ transactionHash: hash }),
    claimWalletTokens: vi.fn().mockResolvedValue({ amount: "10000", txHash: hash }),
  };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const show = (props = {}) => render(<AccountWallet address={address} email="own@example.com" services={services} {...props} />);
const ready = async () => waitFor(() => expect(screen.getByRole("button", { name: "Refresh" }).disabled).toBe(false));
async function prepare(amount = "2.5", to = other) {
  fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
  fireEvent.change(screen.getByLabelText("Recipient address"), { target: { value: to } });
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: amount } });
  fireEvent.click(screen.getByRole("button", { name: "Review transfer" }));
}
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

it("shows only the verified member's email, full copyable address and three balances", async () => {
  const writeText = vi.fn().mockResolvedValue();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  show(); await ready();
  expect(screen.getByText("own@example.com")).toBeTruthy();
  expect(screen.getByText(address)).toBeTruthy();
  expect(screen.getByText("XSGD")).toBeTruthy(); expect(screen.getByText("USDT")).toBeTruthy(); expect(screen.getByText("USDC")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy wallet address" }));
  await screen.findByText("Wallet address copied."); expect(writeText).toHaveBeenCalledWith(address);
});
it("does not reveal account details or request balances for a mismatched embedded wallet", () => {
  state.wallet.address = other; show();
  expect(screen.queryByText("own@example.com")).toBeNull(); expect(screen.queryByText(address)).toBeNull();
  expect(services.readWalletBalances).not.toHaveBeenCalled();
});
it("requires explicit review and confirmation, and refreshes after a confirmed send", async () => {
  show(); await ready(); await prepare();
  expect(screen.getByRole("dialog", { name: "Confirm token transfer" })).toBeTruthy();
  expect(screen.getByText(/Gas is sponsored/)).toBeTruthy();
  expect(services.sendWalletTokens).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
  await screen.findByText("USDC transfer confirmed.");
  expect(services.sendWalletTokens).toHaveBeenCalledOnce();
  expect(services.sendWalletTokens.mock.calls[0][0]).toMatchObject({ token: "USDC", amount: 2_500_000n, address, recipient: expect.stringMatching(/^0x[bB]{40}$/) });
  expect(services.readWalletBalances).toHaveBeenCalledTimes(2);
});
it.each([["0", other, /greater than 0/], ["6", other, /balance is too low/], ["1", address, /other than your own/], ["1.0000001", other, /at most 6/]])("rejects invalid transfer %s before transaction", async (amount, to, error) => {
  show(); await ready(); await prepare(amount, to);
  expect(screen.getByRole("alert").textContent).toMatch(error); expect(services.sendWalletTokens).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Confirm and send" })).toBeNull();
});
it("cancel and Back preserve entries without initiating a transfer", async () => {
  show(); await ready(); await prepare();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByLabelText("Amount").value).toBe("2.5");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull(); expect(services.sendWalletTokens).not.toHaveBeenCalled();
});
it("decline retains review and requires a new explicit click", async () => {
  services.sendWalletTokens.mockRejectedValueOnce(new Error("You declined the wallet request."));
  show(); await ready(); await prepare();
  fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
  await screen.findByText("You declined the wallet request.");
  expect(services.sendWalletTokens).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
  await screen.findByText("USDC transfer confirmed."); expect(services.sendWalletTokens).toHaveBeenCalledTimes(2);
});
it("blocks duplicate sends and recovers a known hash without another wallet request", async () => {
  const flight = deferred();
  services.sendWalletTokens.mockImplementation(async input => { input.onSubmitted({ transactionHash: hash }); return flight.promise; });
  show(); await ready(); await prepare();
  const send = screen.getByRole("button", { name: "Confirm and send" }); fireEvent.click(send); fireEvent.click(send);
  expect(services.sendWalletTokens).toHaveBeenCalledOnce();
  flight.reject(Object.assign(new Error("Pending confirmation."), { walletOutcome: "pending", transactionHash: hash }));
  await screen.findByText("Pending confirmation.");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getByRole("button", { name: "Send", exact: true }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Check transfer status" }));
  await screen.findByText("Token transfer confirmed.");
  expect(services.confirmWalletTokenTransfer).toHaveBeenCalledWith(expect.objectContaining({ transactionHash: hash, amount: 2_500_000n }));
  expect(services.sendWalletTokens).toHaveBeenCalledOnce();
});
it("signs a token-specific faucet message and presents the faucet's cooldown message", async () => {
  services.claimWalletTokens.mockRejectedValueOnce(new Error("This wallet can claim USDT again at 12:30."));
  show(); await ready(); fireEvent.click(screen.getByRole("button", { name: "Faucet" }));
  fireEvent.click(screen.getByRole("combobox", { name: "Token" }));
  fireEvent.click(screen.getByRole("option", { name: "USDT" }));
  fireEvent.click(screen.getByRole("button", { name: "Claim USDT" }));
  await screen.findByText("This wallet can claim USDT again at 12:30.");
  expect(state.wallet.signMessage.mock.calls[0][0]).toMatch(/^TAP Faucet Mint\nToken: USDT\nRecipient: 0x[aA]{40}\nChain ID: 421614\nIssued At: \d+$/);
  expect(services.claimWalletTokens).toHaveBeenCalledWith({ token: "USDT", issuedAt: expect.any(Number), signature: expect.any(String) });
  fireEvent.click(screen.getByRole("button", { name: "Claim USDT" }));
  await screen.findByText("10000 test USDT claimed."); expect(services.readWalletBalances).toHaveBeenCalledTimes(2);
});
it("the on-ramp preview never signs, sends, claims or opens a payment window", async () => {
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  show(); await ready(); fireEvent.click(screen.getByRole("button", { name: "Add funds" }));
  expect(screen.getByRole("dialog", { name: "Privy on-ramp preview" })).toBeTruthy();
  expect(screen.getByText(/Card funding is unavailable on testnet/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(state.wallet.signMessage).not.toHaveBeenCalled(); expect(services.sendWalletTokens).not.toHaveBeenCalled(); expect(services.claimWalletTokens).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); open.mockRestore();
});
it("discards balance results across an A to B to A session change", async () => {
  const old = deferred(); services.readWalletBalances.mockReturnValueOnce(old.promise);
  const view = show();
  state.wallet = { ...state.wallet, address: other, email: "other@example.com" };
  view.rerender(<AccountWallet address={other} email="other@example.com" services={services} />);
  await ready();
  expect(screen.queryByText("own@example.com")).toBeNull();
  state.wallet = { ...state.wallet, address, email: "own@example.com" };
  view.rerender(<AccountWallet address={address} email="own@example.com" services={services} />);
  await ready(); old.resolve({ XSGD: 999_000_000n, USDT: 999_000_000n, USDC: 999_000_000n });
  await waitFor(() => expect(services.readWalletBalances).toHaveBeenCalledTimes(3));
  expect(screen.queryByText("999")).toBeNull();
});
it("does not relay a faucet signature when the account changed while signing", async () => {
  const signing = deferred(); state.wallet.signMessage.mockReturnValue(signing.promise);
  const view = show(); await ready(); fireEvent.click(screen.getByRole("button", { name: "Faucet" })); fireEvent.click(screen.getByRole("button", { name: "Claim USDC" }));
  state.wallet = { ...state.wallet, address: other };
  view.rerender(<AccountWallet address={other} email="other@example.com" services={services} />);
  signing.resolve("0xsignature"); await ready();
  expect(services.claimWalletTokens).not.toHaveBeenCalled(); expect(screen.queryByRole("dialog")).toBeNull();
});
it("restores a pending transfer after remount and only checks its existing hash", async () => {
  services.sendWalletTokens.mockRejectedValue(Object.assign(new Error("Confirmation unavailable."), { walletOutcome: "pending", transactionHash: hash }));
  const view = show(); await ready(); await prepare();
  fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
  await screen.findByText("Confirmation unavailable."); view.unmount();
  show(); await ready();
  expect(screen.getByRole("button", { name: "Send", exact: true }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Check transfer status" }));
  await screen.findByText("Token transfer confirmed.");
  expect(services.sendWalletTokens).toHaveBeenCalledOnce();
  expect(services.confirmWalletTokenTransfer).toHaveBeenCalledWith(expect.objectContaining({ transactionHash: hash, amount: 2_500_000n }));
});
it("wallet details and the transfer review expose accessible names and fields", async () => {
  const view = show(); await ready();
  const options = { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } };
  expect((await axe.run(view.container, options)).violations).toEqual([]);
  await prepare();
  expect((await axe.run(screen.getByRole("dialog"), options)).violations).toEqual([]);
});
it("refuses to open a wallet send if recovery storage cannot be written", async () => {
  show(); await ready(); await prepare();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage disabled"); });
  fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
  await screen.findByText(/Enable site storage before sending tokens/);
  expect(services.sendWalletTokens).not.toHaveBeenCalled();
});
it("keeps the saved unresolved intent if storage fails after a broadcast", async () => {
  const write = Storage.prototype.setItem;
  let intentSaved = false;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
    if (key.endsWith(":probe")) return write.call(this, key, value);
    if (!intentSaved) { intentSaved = true; return write.call(this, key, value); }
    throw new Error("Storage became full");
  });
  services.sendWalletTokens.mockImplementation(async input => {
    input.onSubmitted({ transactionHash: hash });
    throw Object.assign(new Error("Receipt unavailable."), { walletOutcome: "pending", transactionHash: hash });
  });
  const view = show(); await ready(); await prepare();
  fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
  await screen.findByText("Receipt unavailable."); view.unmount();
  expect(JSON.parse(sessionStorage.getItem(`qcdao:wallet-transfer:${address}`)).unresolved).toBe(true);
  show(); await ready();
  expect(screen.getByRole("button", { name: "Send", exact: true }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Check transfer status" }));
  await screen.findByText("Token transfer confirmed.");
  expect(services.confirmWalletTokenTransfer).toHaveBeenCalledWith(expect.objectContaining({ transactionHash: hash }));
  expect(services.sendWalletTokens).toHaveBeenCalledOnce();
});
it("keeps unknown-hash recovery blocked through refresh until exact transfer confirmation", async () => {
  const confirmed = deferred();
  services.sendWalletTokens.mockRejectedValue(Object.assign(new Error("Broadcast outcome unknown."), { walletOutcome: "pending" }));
  services.recoverPendingSponsoredTransaction = vi.fn().mockResolvedValue(hash);
  services.confirmWalletTokenTransfer.mockReturnValue(confirmed.promise);
  show(); await ready(); await prepare(); fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
  await screen.findByText("Broadcast outcome unknown."); fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" })); await ready();
  expect(screen.getByRole("button", { name: "Send", exact: true }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Check transfer status" }));
  await waitFor(() => expect(services.confirmWalletTokenTransfer).toHaveBeenCalledWith(expect.objectContaining({ transactionHash: hash, token: "USDC", amount: 2_500_000n })));
  expect(screen.getByRole("button", { name: "Send", exact: true }).disabled).toBe(true);
  await act(async () => confirmed.resolve({ transactionHash: hash }));
  await screen.findByText("Token transfer confirmed."); expect(services.sendWalletTokens).toHaveBeenCalledOnce();
});
it("a late submitted hash remains pending after A to B to A even when the old caller times out", async () => {
  const flight = deferred(); let submitted;
  services.sendWalletTokens.mockImplementation(input => { submitted = input.onSubmitted; return flight.promise; });
  const view = show(); await ready(); await prepare(); fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
  state.wallet = { ...state.wallet, address: other };
  view.rerender(<AccountWallet address={other} email="other@example.com" services={services} />); await ready();
  state.wallet = { ...state.wallet, address };
  view.rerender(<AccountWallet address={address} email="own@example.com" services={services} />); await ready();
  expect(screen.getByRole("button", { name: "Send", exact: true }).disabled).toBe(true);
  await act(async () => { submitted({ transactionHash: hash }); flight.reject(Object.assign(new Error("Old caller timed out"), { walletOutcome: "pending", transactionHash: hash })); });
  expect(screen.getByRole("button", { name: "Send", exact: true }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Check transfer status" }));
  await screen.findByText("Token transfer confirmed.");
  expect(services.sendWalletTokens).toHaveBeenCalledOnce();
  expect(services.confirmWalletTokenTransfer).toHaveBeenCalledWith(expect.objectContaining({ transactionHash: hash }));
});
it("shows a short decline message for a verbose viem-wrapped rejection and preserves the transfer", async () => {
  services.sendWalletTokens.mockRejectedValueOnce(Object.assign(new Error(`User rejected the request.\nContract Call:\naddress: ${address}\nargs: (${other}, 2500000)\ncalldata: 0xa9059cbb\nVersion: viem@2.56.5`, { cause: { code: 4001, message: "User rejected the request." } }), { name: "ContractFunctionExecutionError" }));
  show(); await ready(); await prepare(); fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
  await screen.findByText("The wallet request was declined. Your entries are kept; retry when ready.");
  expect(screen.getByRole("alert").textContent).not.toMatch(/calldata|Contract Call|viem|2500000/);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByLabelText("Amount").value).toBe("2.5"); expect(screen.getByLabelText("Recipient address").value).toBe(other);
  expect(services.sendWalletTokens).toHaveBeenCalledOnce();
});
it.each([
  [Object.assign(new Error("HTTP request failed. URL: https://rpc.example/private-key\nRequest body: private-sentinel"), { name: "HttpRequestError" }), /could not be reached/],
  [Object.assign(new Error("RPC quota exceeded at https://rpc.example/private-key"), { status: 429 }), /over its request limit/],
  [Object.assign(new Error("Contract Call:\nargs: private-sentinel\ncalldata: 0xa9059cbb"), { name: "ContractFunctionExecutionError" }), /wallet request could not be completed/],
])("keeps transport and contract diagnostics out of the wallet UI", async (error, expected) => {
  services.sendWalletTokens.mockRejectedValueOnce(error);
  show(); await ready(); await prepare(); fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(expected));
  expect(screen.getByRole("alert").textContent).not.toMatch(/private-sentinel|private-key|calldata|Contract Call/);
});
it("preserves the callable faucet cooldown message exactly even when it names a rate limit", async () => {
  const cooldown = "Faucet rate limit: this wallet can claim USDC again at 12:30.";
  services.claimWalletTokens.mockRejectedValueOnce(Object.assign(new Error(cooldown), { code: "functions/resource-exhausted" }));
  show(); await ready(); fireEvent.click(screen.getByRole("button", { name: "Faucet" })); fireEvent.click(screen.getByRole("button", { name: "Claim USDC" }));
  await screen.findByText(cooldown); expect(screen.getByRole("alert").textContent).toBe(cooldown);
});
