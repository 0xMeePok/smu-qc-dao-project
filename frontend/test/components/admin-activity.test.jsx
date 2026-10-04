import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchAdminActivity: vi.fn(), openTab: vi.fn() }));
vi.mock("../../src/lib/adminActivity.js", async () => {
  const actual = await vi.importActual("../../src/lib/adminActivity.js");
  return { ...actual, fetchAdminActivity: mocks.fetchAdminActivity };
});

import { AdminActivityPanel } from "../../src/components/AdminActivityPanel.jsx";

const summary = (overrides = {}) => ({
  users: { total: 12, byRole: { user: 9, evaluator: 2, administrator: 1 }, suspended: 1 },
  postings: { active: 4, total: 7, feedbackGatesOutstanding: 2 },
  proposals: { open: 6, total: 9, selectionsInProgress: 1 },
  evaluatorFeedback: { qualifyingComments: 5 },
  moderation: { pending: 3 },
  anchoring: { failed: 2 },
  escrow: { backedProposals: 2, targetBaseUnits: "90071992547409910001", mockFunded: 1250 },
  truncated: {},
  generatedAt: "2026-10-03T09:00:00.000Z",
  ...overrides,
});

const group = (name) => screen.getByRole("heading", { name }).closest(".admin-activity-group");

beforeEach(() => {
  mocks.openTab.mockReset();
  mocks.fetchAdminActivity.mockReset().mockResolvedValue(summary());
});
afterEach(cleanup);

describe("QCDAO-140 administrator platform activity", () => {
  it("reports every count the story asks for", async () => {
    render(<AdminActivityPanel onOpenTab={mocks.openTab} />);
    await screen.findByRole("heading", { name: "People" });

    expect(within(group("People")).getByText("9")).toBeTruthy();
    expect(within(group("People")).getByText("Evaluator")).toBeTruthy();
    expect(within(group("Marketplace")).getByText("4")).toBeTruthy();
    expect(within(group("Marketplace")).getByText("Selections in progress")).toBeTruthy();
    expect(within(group("Evaluator feedback")).getByText("5")).toBeTruthy();
    expect(within(group("Needs an administrator")).getByText("3")).toBeTruthy();
    expect(within(group("Escrow")).getByText("2")).toBeTruthy();
  });

  it("shows exact escrow base units without rounding them through a float", async () => {
    render(<AdminActivityPanel onOpenTab={mocks.openTab} />);
    await screen.findByRole("heading", { name: "Escrow" });
    // Beyond Number.MAX_SAFE_INTEGER: parsing this would silently change it.
    expect(within(group("Escrow")).getByText("90,071,992,547,409,910,001")).toBeTruthy();
  });

  it("leads with the work that needs an administrator", async () => {
    render(<AdminActivityPanel onOpenTab={mocks.openTab} />);
    await screen.findByRole("heading", { name: "Needs an administrator" });
    const groups = [...document.querySelectorAll(".admin-activity-group h3")].map((node) => node.textContent);
    expect(groups[0]).toBe("Needs an administrator");
    expect((await screen.findByRole("status")).textContent).toMatch(/5 items need an administrator/);
  });

  it("says plainly when nothing is waiting", async () => {
    mocks.fetchAdminActivity.mockResolvedValue(summary({
      moderation: { pending: 0 }, anchoring: { failed: 0 },
      postings: { active: 4, total: 7, feedbackGatesOutstanding: 0 },
    }));
    render(<AdminActivityPanel onOpenTab={mocks.openTab} />);
    await screen.findByRole("heading", { name: "Needs an administrator" });
    expect(screen.getByText("Nothing is waiting.")).toBeTruthy();
    expect(screen.getByText("Every queued anchor has settled.")).toBeTruthy();
    expect((await screen.findByRole("status")).textContent).not.toMatch(/need an administrator/);
  });

  it("links into the queues that resolve the counts", async () => {
    render(<AdminActivityPanel onOpenTab={mocks.openTab} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open moderation queue" }));
    expect(mocks.openTab).toHaveBeenCalledWith("moderation");
    fireEvent.click(screen.getByRole("button", { name: "Open user management" }));
    expect(mocks.openTab).toHaveBeenCalledWith("users");
  });

  it("admits when a count stopped at the scan cap rather than showing a confident wrong number", async () => {
    mocks.fetchAdminActivity.mockResolvedValue(summary({ truncated: { users: true } }));
    render(<AdminActivityPanel onOpenTab={mocks.openTab} />);
    await screen.findByRole("heading", { name: "People" });
    expect(within(group("People")).getByText(/The real total is higher/)).toBeTruthy();
    expect(within(group("Marketplace")).queryByText(/The real total is higher/)).toBeNull();
  });

  it("surfaces a failure instead of rendering zeros as fact", async () => {
    mocks.fetchAdminActivity.mockRejectedValueOnce(new Error("permission-denied"));
    render(<AdminActivityPanel onOpenTab={mocks.openTab} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "People" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "People" })).toBeTruthy());
  });
});
