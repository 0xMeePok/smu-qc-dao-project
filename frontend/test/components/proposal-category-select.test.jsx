import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProposalCategorySelect } from "../../src/components/ProposalCategorySelect.jsx";

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);
function Form({ disabled = false }) {
  const [value, setValue] = useState("");
  return <form onSubmit={(event) => event.preventDefault()}><label htmlFor="category">Category</label><ProposalCategorySelect id="category" value={value} onChange={setValue} disabled={disabled} /><button type="submit">Submit</button><output>{value}</output></form>;
}
it("selects by pointer, marks the saved choice and dismisses outside", () => {
  render(<Form />);
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name: "Quantum annealing" }));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("quantum-annealing");
  expect(document.activeElement).toBe(screen.getByRole("combobox"));
  fireEvent.click(screen.getByRole("combobox"));
  expect(screen.getByRole("option", { name: "Quantum annealing" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("listbox")).toBeNull();
});
it("supports arrow navigation, commit, Escape, typeahead and Tab without changing a cancelled selection", () => {
  render(<Form />);
  const combo = screen.getByRole("combobox");
  fireEvent.keyDown(combo, { key: "ArrowDown" });
  fireEvent.keyDown(combo, { key: "ArrowDown" });
  fireEvent.keyDown(combo, { key: "Enter" });
  expect(screen.getByRole("status").textContent).toBe("quantum-inspired");
  fireEvent.keyDown(combo, { key: "End" });
  fireEvent.keyDown(combo, { key: "Escape" });
  expect(screen.getByRole("status").textContent).toBe("quantum-inspired");
  fireEvent.keyDown(combo, { key: "h" });
  fireEvent.keyDown(combo, { key: "Enter" });
  expect(screen.getByRole("status").textContent).toBe("hybrid");
  fireEvent.click(combo);
  fireEvent.keyDown(combo, { key: "Tab" });
  expect(screen.queryByRole("listbox")).toBeNull();
});
it("cannot open when submission is disabled", () => {
  render(<Form disabled />);
  fireEvent.click(screen.getByRole("combobox"));
  expect(screen.queryByRole("listbox")).toBeNull();
});
