import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import axe from "axe-core";
import { TokenSelect } from "../../src/components/TokenSelect.jsx";
import { Modal } from "../../src/components/Modal.jsx";

afterEach(cleanup);
const options = ["USDT", "USDC", "XSGD"].map((value) => ({ value, label: value }));
function Picker({ disabled = false }) {
  const [value, setValue] = useState("USDC");
  return <><label htmlFor="currency">Currency</label><TokenSelect id="currency" name="currency" value={value}
    onChange={(event) => setValue(event.target.value)} options={options} disabled={disabled} required /></>;
}

it("commits a pointer choice, retains the selected option and dismisses outside", () => {
  render(<Picker />);
  const combo = screen.getByRole("combobox", { name: "Currency" });
  fireEvent.click(combo);
  expect(screen.getByRole("option", { name: "USDC" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("option", { name: "XSGD" }));
  expect(combo.value).toBe("XSGD");
  expect(document.activeElement).toBe(combo);
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.click(combo); fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("supports keyboard navigation and typeahead without committing a cancelled choice", () => {
  render(<Picker />);
  const combo = screen.getByRole("combobox", { name: "Currency" });
  fireEvent.keyDown(combo, { key: "Home" }); fireEvent.keyDown(combo, { key: "Enter" });
  expect(combo.value).toBe("USDT");
  fireEvent.keyDown(combo, { key: "ArrowDown" }); fireEvent.keyDown(combo, { key: "ArrowDown" });
  fireEvent.keyDown(combo, { key: "Escape" }); expect(combo.value).toBe("USDT");
  fireEvent.keyDown(combo, { key: "x" }); fireEvent.keyDown(combo, { key: "Enter" });
  expect(combo.value).toBe("XSGD");
  fireEvent.keyDown(combo, { key: "End" }); fireEvent.keyDown(combo, { key: "Tab" });
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("closes the picker on Escape before dismissing its containing wallet dialog", () => {
  const dismiss = vi.fn();
  render(<Modal labelledBy="wallet-title" onDismiss={dismiss}><h2 id="wallet-title">Wallet</h2><Picker /></Modal>);
  const combo = screen.getByRole("combobox", { name: "Currency" });
  fireEvent.click(combo); fireEvent.keyDown(combo, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull(); expect(dismiss).not.toHaveBeenCalled();
  fireEvent.keyDown(combo, { key: "Escape" }); expect(dismiss).toHaveBeenCalledOnce();
});

it("cannot reopen a stale popup after it becomes disabled", () => {
  const view = render(<Picker />);
  fireEvent.click(screen.getByRole("combobox"));
  view.rerender(<Picker disabled />);
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.click(screen.getByRole("combobox")); expect(screen.queryByRole("listbox")).toBeNull();
  view.rerender(<Picker />); expect(screen.queryByRole("listbox")).toBeNull();
});

it("has labelled keyboard controls and an accessible expanded option list", async () => {
  const { container } = render(<main><Picker /></main>);
  fireEvent.click(screen.getByRole("combobox", { name: "Currency" }));
  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  expect(results.violations).toEqual([]);
});
