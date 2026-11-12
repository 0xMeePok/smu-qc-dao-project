import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import HomePage from "../../src/pages/HomePage.jsx";

afterEach(cleanup);
it("switches the visible workflow example with the step buttons", () => {
  render(<HomePage onNavigate={vi.fn()} onOpenWorkspaces={vi.fn()} />);
  const workflow = within(screen.getByRole("region", { name: "From brief to delivery" }));
  expect(workflow.getByRole("group", { name: "Publish." })).toBeTruthy();
  fireEvent.click(workflow.getByRole("button", { name: "Propose." }));
  expect(within(workflow.getByRole("group", { name: "Propose." })).getByText("Proposals · 3 received")).toBeTruthy();
  expect(workflow.getByRole("button", { name: "Propose." }).getAttribute("aria-current")).toBe("step");
  fireEvent.click(workflow.getByRole("button", { name: "Deliver." }));
  expect(within(workflow.getByRole("group", { name: "Deliver." })).getByText("Delivery · Payment approvals")).toBeTruthy();
  expect(workflow.queryByRole("group", { name: "Propose." })).toBeNull();
});
