import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import axe from "axe-core";

const state = vi.hoisted(() => ({ functions: {}, calls: [] }));
vi.mock("../../src/lib/firebase.js", () => ({ get functions() { return state.functions; } }));
vi.mock("firebase/functions", () => ({
  httpsCallable: (_functions, name) => async (data) => {
    state.calls.push({ name, data });
    if (data.action === "quote" && data.amount === "0.50") throw new Error("Enter an amount from 0.01 to 100000, with at most 2 decimal places.");
    if (data.action === "quote" && data.direction === "offramp") {
      return { data: { quote: {
        token: "quote-token-offramp",
        source: { rail: "arbitrum-sepolia", currency: "USDC", amount: "100.00", fee: "0.50" },
        destination: { rail: "fast", currency: "SGD", amount: "134.32", fee: "0.00" },
        fxRate: "1.35",
        expiresAt: "2026-11-03T00:02:00.000Z",
      } } };
    }
    if (data.action === "quote") {
      return { data: { quote: {
        token: "quote-token-onramp",
        source: { rail: "ach", currency: "USD", amount: "100.00", fee: "0.50" },
        destination: { rail: "arbitrum-sepolia", currency: "USDC", amount: "99.50", fee: "0" },
        fxRate: "1.00",
        expiresAt: "2026-11-03T00:02:00.000Z",
      } } };
    }
    if (data.action === "create" && data.direction === "offramp") {
      return { data: { transfer: { id: "tf_sell", status: "awaiting_funds", fundingAddress: `0x${"c".repeat(40)}`, source: { amount: "100.00", currency: "USDC" } } } };
    }
    if (data.action === "create") {
      return { data: { transfer: {
        id: "tf_buy", status: "awaiting_funds", memo: "SIM-ref",
        details: { bankName: "Due sandbox bank", accountNumber: "1234567890" },
        source: { amount: "100.00", currency: "USD" },
      } } };
    }
    if (data.action === "payin") return { data: { transfer: { id: "tf_buy", status: "payment_processed" } } };
    return { data: { transfer: { id: data.transferId, status: "awaiting_funds" } } };
  },
}));
import { DueOnOffRamp } from "../../src/components/DueOnOffRamp.jsx";

const address = `0x${"a".repeat(40)}`;
afterEach(() => { cleanup(); state.functions = {}; state.calls = []; vi.restoreAllMocks(); });
const open = () => {
  render(<DueOnOffRamp address={address} />);
  fireEvent.click(screen.getByRole("button", { name: "Add funds" }));
  return screen.getByRole("dialog", { name: "Add funds" });
};

it("asks the dueSandbox function for a buy quote and shows the bank details it returns", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
  const dialog = open();
  expect(within(dialog).getByText("Testnet simulation")).toBeTruthy();
  expect(within(dialog).getByText(address)).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText("Amount (USD)"), { target: { value: "100.00" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Review quote" }));
  expect(await within(dialog).findByText("99.50 USDC")).toBeTruthy();
  expect(within(dialog).getByText("0.50 USD")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue to confirmation" }));
  expect(within(dialog).getByText(/does not send crypto from your wallet/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Create sandbox transfer" }));
  expect(await within(dialog).findByText("1234567890")).toBeTruthy();
  expect(within(dialog).getByText("SIM-ref")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Simulate sandbox pay-in" }));
  expect(await within(dialog).findByText(/payment_processed/)).toBeTruthy();
  expect(state.calls.map((call) => call.data.action)).toEqual(["quote", "create", "payin"]);
  expect(state.calls.every((call) => call.name === "dueSandbox")).toBe(true);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("shows the funding address Due returns for a sale and does not offer a wallet send", async () => {
  const dialog = open();
  fireEvent.click(within(dialog).getByRole("radio", { name: /Sell USDC/ }));
  fireEvent.change(within(dialog).getByLabelText("Currency"), { target: { value: "SGD" } });
  fireEvent.change(within(dialog).getByLabelText("Amount (USDC)"), { target: { value: "100" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Review quote" }));
  expect(await within(dialog).findByText("134.32 SGD")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue to confirmation" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Create sandbox transfer" }));
  expect(await within(dialog).findByText(`0x${"c".repeat(40)}`)).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "Send" })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Simulate sandbox deposit" })).toBeNull();
  expect(state.calls[0].data).toMatchObject({ action: "quote", direction: "offramp", currency: "SGD", amount: "100" });
});

it("shows the function's amount error and does not open a transfer", async () => {
  const dialog = open();
  fireEvent.change(within(dialog).getByLabelText("Amount (USD)"), { target: { value: "0.50" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Review quote" }));
  expect((await within(dialog).findByRole("alert")).textContent).toMatch(/0\.01 to 100000/);
  expect(within(dialog).queryByRole("button", { name: "Create sandbox transfer" })).toBeNull();
});

it("names the missing functions configuration instead of calling Due from the browser", async () => {
  state.functions = null;
  const dialog = open();
  fireEvent.change(within(dialog).getByLabelText("Amount (USD)"), { target: { value: "10" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Review quote" }));
  expect((await within(dialog).findByRole("alert")).textContent).toMatch(/firebase\/functions\/\.env/);
  await waitFor(() => expect(state.calls).toEqual([]));
});

it("exposes an accessible name on the sandbox dialog", async () => {
  const view = render(<DueOnOffRamp address={address} />);
  fireEvent.click(screen.getByRole("button", { name: "Add funds" }));
  const dialog = screen.getByRole("dialog", { name: "Add funds" });
  expect((await axe.run(dialog, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations).toEqual([]);
  expect((await axe.run(view.container, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations).toEqual([]);
});
