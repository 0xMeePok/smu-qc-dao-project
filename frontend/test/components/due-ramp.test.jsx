import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import axe from "axe-core";
import { DueOnOffRamp } from "../../src/components/DueOnOffRamp.jsx";

const address = `0x${"a".repeat(40)}`;
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const open = () => {
  render(<DueOnOffRamp address={address} email="funder@example.com" />);
  fireEvent.click(screen.getByRole("button", { name: "Add funds" }));
  return screen.getByRole("dialog", { name: "Add funds" });
};

it("walks an on-ramp through review, confirmation, fictional bank details and a processed simulation", () => {
  const openWindow = vi.spyOn(window, "open").mockImplementation(() => null);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
  const dialog = open();
  expect(within(dialog).getByText("Testnet simulation")).toBeTruthy();
  expect(within(dialog).getByText(/No request is sent to Due/)).toBeTruthy();
  expect(within(dialog).getByText(address)).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText("Amount (USD)"), { target: { value: "100.00" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Review quote" }));
  expect(within(dialog).getByText("99.500000 USDC")).toBeTruthy();
  expect(within(dialog).getByText("0.50 USD")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue to confirmation" }));
  expect(within(dialog).getByText(/local transfer record only/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue simulation" }));
  expect(within(dialog).getByText(/bank details are fictional/)).toBeTruthy();
  expect(within(dialog).getByText("0000000000")).toBeTruthy();
  expect(within(dialog).getByText("SIM-tf_1")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Simulate sandbox pay-in" }));
  for (const status of ["awaiting_funds", "approved", "payment_submitted", "payment_processed"]) {
    expect(within(dialog).getByText(new RegExp(`\\(${status}\\)`))).toBeTruthy();
  }
  expect(within(dialog).getByText(/balance is unchanged/)).toBeTruthy();
  expect(openWindow).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("walks an off-ramp without showing a funding address or a send button", () => {
  const dialog = open();
  fireEvent.click(within(dialog).getByRole("radio", { name: /Sell USDC/ }));
  fireEvent.change(within(dialog).getByLabelText("Currency"), { target: { value: "SGD" } });
  expect(within(dialog).getByLabelText("Payment method").value).toBe("fast");
  fireEvent.change(within(dialog).getByLabelText("Amount (USDC)"), { target: { value: "100" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Review quote" }));
  expect(within(dialog).getByText("134.32 SGD")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue to confirmation" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue simulation" }));
  expect(within(dialog).getByText("sandbox-funding:tf_1")).toBeTruthy();
  expect(within(dialog).getByText(/not a wallet address/)).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "Send" })).toBeNull();
  expect(within(dialog).queryByText(address)).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Simulate sandbox deposit" }));
  expect(within(dialog).getByText(/payment_processed/)).toBeTruthy();
});

it("keeps an invalid amount on the details step", () => {
  const dialog = open();
  fireEvent.change(within(dialog).getByLabelText("Amount (USD)"), { target: { value: "0.50" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Review quote" }));
  expect(within(dialog).getByRole("alert").textContent).toMatch(/larger amount/);
  expect(within(dialog).queryByRole("button", { name: "Continue simulation" })).toBeNull();
});

it("asks for a wallet before quoting when the entry point has no address", () => {
  render(<DueOnOffRamp />);
  fireEvent.click(screen.getByRole("button", { name: "Add funds" }));
  const dialog = screen.getByRole("dialog", { name: "Add funds" });
  expect(within(dialog).getByRole("alert").textContent).toMatch(/Sign in with your email/);
  expect(within(dialog).queryByRole("button", { name: "Review quote" })).toBeNull();
});

it("exposes an accessible name on the simulation dialog", async () => {
  const view = render(<DueOnOffRamp address={address} email="funder@example.com" />);
  fireEvent.click(screen.getByRole("button", { name: "Add funds" }));
  const dialog = screen.getByRole("dialog", { name: "Add funds" });
  expect((await axe.run(dialog, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations).toEqual([]);
  expect((await axe.run(view.container, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations).toEqual([]);
});
