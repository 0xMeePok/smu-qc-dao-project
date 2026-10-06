import React from "react";
import { cleanup, fireEvent, render as renderBare, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** QCDAO-93 - the solution developer's roll-up of their submissions. */

const mocks = vi.hoisted(() => ({ listMyProposalQueue: vi.fn(), listActionItems: vi.fn() }));
vi.mock("../../src/lib/proposalQueues.js", async (importOriginal) => ({
  ...(await importOriginal()),
  listMyProposalQueue: mocks.listMyProposalQueue,
  listActionItems: mocks.listActionItems,
}));
vi.mock("../../src/lib/firebase.js", () => ({ db: {}, functions: {}, auth: null }));
vi.mock("../../src/lib/fundingApproach.js", async (importOriginal) => ({
  ...(await importOriginal()),
  listFundingApproaches: vi.fn().mockResolvedValue({ incoming: [], sent: [], truncated: {} }),
}));
vi.mock("../../src/context/AuthContext.jsx", () => ({
  useAuth: () => ({ user: { id: `0x${"a".repeat(40)}`, org: "SMU" } }),
}));

import { DeveloperDashboardPanel } from "../../src/components/DeveloperDashboardPanel.jsx";

const render = (ui) => renderBare(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>,
);

const row = (overrides = {}) => ({
  id: "s1",
  title: "Annealing study",
  status: "submitted",
  workflowStatus: "submitted",
  createdAt: "2026-09-01T00:00:00.000Z",
  problemId: "p1",
  posting: { id: "p1", title: "Cold-chain routing", status: "open", expiresAt: "2099-01-01T00:00:00.000Z" },
  comments: 0,
  qualifying: 0,
  recommendations: [],
  recommendationComments: [],
  ...overrides,
});

const EMPTY_ACTIONS = { total: 0, owner: { readyToSelect: [], awaitingReview: [] },
  researcher: { selectionToAccept: [], grantSelectionsToAccept: [] }, evaluator: null, escrowActions: [] };

const queue = (items, extra = {}) => mocks.listMyProposalQueue.mockResolvedValue({ items, truncated: false, ...extra });

beforeEach(() => {
  mocks.listMyProposalQueue.mockReset();
  queue([row()]);
  mocks.listActionItems.mockReset().mockResolvedValue(EMPTY_ACTIONS);
});
afterEach(cleanup);

const group = (name) => screen.getByRole("heading", { name: new RegExp(`^${name}`) }).closest(".card-table");

describe("QCDAO-93 solution developer dashboard", () => {
  it("separates solutions nobody has looked at from solutions with feedback", async () => {
    queue([
      row(),
      row({ id: "s2", title: "Routing heuristic", comments: 3, qualifying: 1, recommendations: ["recommend"],
        recommendationComments: [{ commentId: "c1", recommendation: "recommend", at: "2026-10-01T00:00:00.000Z" }] }),
    ]);
    render(<DeveloperDashboardPanel onNavigate={vi.fn()} />);
    await screen.findByText("Routing heuristic");
    expect(within(group("Awaiting evaluator feedback")).getByText("Annealing study")).toBeTruthy();
    expect(within(group("Evaluator feedback received")).getByText("Routing heuristic")).toBeTruthy();
  });

  it("links to the recommendation comment and shows no score, weighting or ranking", async () => {
    queue([row({ comments: 2, qualifying: 1, recommendations: ["recommend_with_revisions"],
      recommendationComments: [{ commentId: "c1", recommendation: "recommend_with_revisions", at: "2026-10-01T00:00:00.000Z" }] })]);
    const onNavigate = vi.fn();
    render(<DeveloperDashboardPanel onNavigate={onNavigate} />);
    await screen.findByText("Annealing study");
    fireEvent.click(screen.getByRole("button", { name: "Read the recommendation" }));
    expect(onNavigate).toHaveBeenCalledWith("proposal/s1?comment=c1");
    // The outcome is the whole of what an author may see: no metric, score,
    // weighting or ranking appears anywhere on the row.
    const item = screen.getByRole("button", { name: "Read the recommendation" }).closest("li");
    expect(within(item).getByText("Evaluator · Recommend with revisions")).toBeTruthy();
    expect(item.textContent).not.toMatch(/score|weight|rank|\d+\s*\/\s*\d+/i);
  });

  it("counts discussion comments apart from evaluator recommendations", async () => {
    queue([row({ comments: 5, qualifying: 2, recommendations: ["recommend", "do_not_recommend"],
      recommendationComments: [
        { commentId: "c1", recommendation: "recommend", at: "2026-10-01T00:00:00.000Z" },
        { commentId: "c2", recommendation: "do_not_recommend", at: "2026-10-02T00:00:00.000Z" },
      ] })]);
    render(<DeveloperDashboardPanel onNavigate={vi.fn()} />);
    await screen.findByText("Annealing study");
    const stat = (label) => screen.getByText(label).closest(".stat-card").querySelector(".stat-num").textContent;
    expect(stat("Recommendations received")).toBe("2");
    // Five visible comments, two of which are filings: three are discussion.
    expect(stat("Discussion comments")).toBe("3");
    // And on the row itself, so an author sees which solution the thread is on.
    const item = screen.getByText("Annealing study").closest(".table-row");
    expect(within(item).getByText(/3 discussion comments/)).toBeTruthy();
    expect(within(item).getByRole("button", { name: "Open discussion" })).toBeTruthy();
  });

  it("leads with a pending dual approval and counts down to its deadline", async () => {
    mocks.listActionItems.mockResolvedValue({
      ...EMPTY_ACTIONS,
      total: 1,
      researcher: {
        selectionToAccept: [{ id: "s1", title: "Annealing study", problemId: "p1",
          posting: { id: "p1", title: "Cold-chain routing" }, workflowStatus: "selected",
          deadlineAt: new Date(Date.now() + 3 * 864e5).toISOString(), submittedAt: "2026-09-01T00:00:00.000Z" }],
        grantSelectionsToAccept: [],
      },
    });
    const onNavigate = vi.fn();
    render(<DeveloperDashboardPanel onNavigate={onNavigate} />);
    await screen.findByText("Selection to accept");
    const item = screen.getByText("Selection to accept").closest(".dashboard-attention-item");
    expect(item.className).toContain("is-dual");
    expect(within(item).getByText("Dual approval")).toBeTruthy();
    expect(within(item).getByText(/Both parties must accept/)).toBeTruthy();
    expect(item.querySelector(".expiry-countdown")).toBeTruthy();
    fireEvent.click(within(item).getByRole("button", { name: "Open acceptance" }));
    expect(onNavigate).toHaveBeenCalledWith("posting/p1?tab=funding");
  });

  it("shows accepted work with its escrow state and a route to the audit record", async () => {
    queue([row({ status: "accepted", workflowStatus: "accepted", escrow: { state: "Active", workflowStatus: "accepted" } })]);
    const onNavigate = vi.fn();
    render(<DeveloperDashboardPanel onNavigate={onNavigate} />);
    await screen.findByText("Accepted solutions");
    const accepted = within(group("Accepted solutions"));
    expect(accepted.getByText(/Escrow: Active/)).toBeTruthy();
    fireEvent.click(accepted.getByRole("button", { name: "Escrow" }));
    expect(onNavigate).toHaveBeenCalledWith("proposal/s1?tab=funding");
    fireEvent.click(accepted.getByRole("button", { name: "Audit record" }));
    expect(onNavigate).toHaveBeenCalledWith("proposal/s1?tab=record");
  });

  it("keeps independent listings in their own group and off the feedback gate", async () => {
    queue([row({ id: "i1", title: "Open annealing library", problemId: null, proposalKind: "independent", posting: null })]);
    render(<DeveloperDashboardPanel onNavigate={vi.fn()} />);
    await screen.findByText("Independent listings");
    const listing = within(group("Independent listings")).getByText("Open annealing library").closest(".table-row");
    expect(within(listing).getByText("Independent listing")).toBeTruthy();
    // No parent opportunity means no evaluator gate to be waiting on.
    expect(screen.queryByRole("heading", { name: /^Awaiting evaluator feedback/ })).toBeNull();
  });

  it("counts drafts without repeating the drafts table below it", async () => {
    queue([row({ id: "d1", title: "Half-written", status: "draft", workflowStatus: "draft" })]);
    render(<DeveloperDashboardPanel onNavigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Nothing submitted yet" })).toBeTruthy();
    expect(screen.getByText(/1 draft saved below/)).toBeTruthy();
    expect(screen.queryByText("Half-written")).toBeNull();
  });

  it("gives a first-time author somewhere to start", async () => {
    queue([]);
    const onNavigate = vi.fn();
    render(<DeveloperDashboardPanel onNavigate={onNavigate} />);
    expect(await screen.findByRole("heading", { name: "No solutions yet" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Browse opportunities" }));
    expect(onNavigate).toHaveBeenCalledWith("discover");
  });

  it("reports a failed load instead of an empty dashboard", async () => {
    mocks.listMyProposalQueue.mockRejectedValue(Object.assign(new Error("nope"), { code: "unauthenticated" }));
    render(<DeveloperDashboardPanel onNavigate={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Sign in again/);
  });
});
