import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import axe from "axe-core";

import { DueOnOffRamp } from "../../src/components/DueOnOffRamp.jsx";
import { resetDueRampMock } from "../../src/lib/dueRampMock.js";

const address = `0x${"a".repeat(40)}`;
afterEach(() => { cleanup(); resetDueRampMock(); vi.restoreAllMocks(); });
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
  expect(await within(dialog).findByText("0000000000")).toBeTruthy();
  expect(within(dialog).getByText("SIM-tf_1")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Simulate sandbox pay-in" }));
  expect(await within(dialog).findByText(/payment_processed/)).toBeTruthy();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("shows the funding address Due returns for a sale and does not offer a wallet send", async () => {
  const dialog = open();
  fireEvent.click(within(dialog).getByRole("radio", { name: /Sell USDC/ }));
  fireEvent.change(within(dialog).getByLabelText("Currency"), { target: { value: "SGD" } });
  fireEvent.change(within(dialog).getByLabelText("Amount (USDC)"), { target: { value: "100" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Review quote" }));
  expect(await within(dialog).findByText("134.33 SGD")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue to confirmation" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Create sandbox transfer" }));
  expect(await within(dialog).findByText("mock-funding-tf_1")).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "Send" })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Simulate sandbox deposit" })).toBeNull();
});

it("shows the function's amount error and does not open a transfer", async () => {
  const dialog = open();
  fireEvent.change(within(dialog).getByLabelText("Amount (USD)"), { target: { value: "0.50" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Review quote" }));
  expect((await within(dialog).findByRole("alert")).textContent).toMatch(/larger amount/);
  expect(within(dialog).queryByRole("button", { name: "Create sandbox transfer" })).toBeNull();
});

it("shows a mock account without calling Due", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
  const dialog = open();
  fireEvent.change(within(dialog).getByLabelText("Amount (USD)"), { target: { value: "10" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Review quote" }));
  expect(await within(dialog).findByText("9.50 USDC")).toBeTruthy();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("exposes an accessible name on the sandbox dialog", async () => {
  const view = render(<DueOnOffRamp address={address} />);
  fireEvent.click(screen.getByRole("button", { name: "Add funds" }));
  const dialog = screen.getByRole("dialog", { name: "Add funds" });
  expect((await axe.run(dialog, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations).toEqual([]);
  expect((await axe.run(view.container, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })).violations).toEqual([]);
});
