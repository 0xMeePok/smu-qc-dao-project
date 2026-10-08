import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import HomePage from "../../src/pages/HomePage.jsx";

afterEach(cleanup);
it("opens each workflow example immediately without scrolling visitors away from the controls", () => {
  const scroll = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
  const view = render(<HomePage onNavigate={vi.fn()} onOpenWorkspaces={vi.fn()} />);
  const workflow = screen.getByRole("region", { name: "From brief to delivery" });
  expect(workflow.classList.contains("is-scrub")).toBe(false);
  fireEvent.click(within(workflow).getByRole("button", { name: "Propose." }));
  expect(within(workflow).getByText("Proposals · 3 received")).toBeTruthy();
  expect(within(workflow).getByRole("button", { name: "Propose." }).getAttribute("aria-current")).toBe("step");
  fireEvent.click(within(workflow).getByRole("button", { name: "Deliver." }));
  expect(within(workflow).getByText("Delivery · Payment approvals")).toBeTruthy();
  expect(within(workflow).queryByText("Proposals · 3 received")).toBeNull();
  expect(scroll).not.toHaveBeenCalled();
  view.unmount();
  scroll.mockRestore();
});
