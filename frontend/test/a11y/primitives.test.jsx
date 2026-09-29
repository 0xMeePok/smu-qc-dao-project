import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Field } from "../../src/components/Field.jsx";
import { Modal } from "../../src/components/Modal.jsx";

afterEach(cleanup);

async function expectAccessible(node) {
  const results = await axe.run(node, {
    rules: {
      // jsdom does not lay out CSS, so contrast is checked from the design tokens instead.
      "color-contrast": { enabled: false },
      region: { enabled: false },
    },
  });
  const details = results.violations.flatMap((violation) =>
    violation.nodes.map((node) => `${violation.id}: ${violation.help} (${node.target.join(" ")})`),
  );
  expect(details).toEqual([]);
}

function BriefForm() {
  const [title, setTitle] = useState("");
  return (
    <form aria-label="Create brief">
      <Field htmlFor="brief-title" label="Title" hint="Shown on the opportunity card." error={title ? undefined : "Enter a title."}>
        {({ id, describedBy, invalid }) => (
          <input id={id} value={title} aria-describedby={describedBy} aria-invalid={invalid} onChange={(event) => setTitle(event.target.value)} />
        )}
      </Field>
      <button className="primary" type="submit">Save brief</button>
      <button className="secondary" type="button">Cancel</button>
    </form>
  );
}

describe("primary controls", () => {
  it("form controls expose names, hints, and errors", async () => {
    const { container } = render(<BriefForm />);
    const title = screen.getByRole("textbox", { name: "Title" });
    expect(title.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Enter a title.");
    expect(title.getAttribute("aria-describedby")).toContain("brief-title-hint");
    fireEvent.change(title, { target: { value: "Quantum routing" } });
    expect(title.getAttribute("aria-invalid")).toBe("false");
    await expectAccessible(container);
  });

  it("cards name their contents", async () => {
    const { container } = render(
      <section className="card-table" aria-labelledby="open-title">
        <div className="table-header"><h2 id="open-title">Open problems</h2></div>
        <a href="#problem-1">Review quantum brief</a>
      </section>,
    );
    expect(screen.getByRole("region", { name: "Open problems" })).toBeTruthy();
    await expectAccessible(container);
  });

  it("dialogs are named, modal, and dismissible from the keyboard", async () => {
    const onDismiss = vi.fn();
    render(
      <Modal labelledBy="withdraw-title" describedBy="withdraw-desc" onDismiss={onDismiss}>
        <h2 id="withdraw-title">Withdraw proposal</h2>
        <p id="withdraw-desc">The sponsor will see this reason.</p>
        <label htmlFor="withdraw-reason">Reason<textarea id="withdraw-reason" /></label>
        <button type="button">Confirm withdrawal</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Withdraw proposal" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-describedby")).toBe("withdraw-desc");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledOnce();
    await expectAccessible(dialog);
  });
});
