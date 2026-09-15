import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Modal } from "../../src/components/Modal.jsx";

afterEach(cleanup);
function DialogFlow() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open decision</button>{open && <Modal labelledBy="test-title" onDismiss={() => setOpen(false)}>
    <h2 id="test-title">Decision</h2><label>Reason<input /></label><button onClick={() => setOpen(false)}>Save decision</button>
  </Modal>}</>;
}

describe("Modal keyboard context", () => {
  it("returns focus to the opener after Escape and successful submission", () => {
    render(<DialogFlow />);
    const opener = screen.getByRole("button", { name: "Open decision" });
    opener.focus(); fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Reason" }));
    fireEvent.keyDown(document.activeElement, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Save decision" }));
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("");
  });

  it("cycles through enabled controls without trapping focus on disabled fields", () => {
    render(<Modal labelledBy="test-title"><h2 id="test-title">Decision</h2><button>First</button><button>Last</button><select disabled aria-label="Disabled reason" /><textarea disabled /></Modal>);
    const first = screen.getByRole("button", { name: "First" }), last = screen.getByRole("button", { name: "Last" });
    last.focus(); fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("keeps a loading dialog keyboard accessible when no controls are enabled", () => {
    render(<Modal labelledBy="test-title"><h2 id="test-title">Loading decision</h2><button disabled>Saving</button></Modal>);
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);
  });
});
