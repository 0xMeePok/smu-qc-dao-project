import React from "react";
import { cleanup, fireEvent, render as renderBare, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** QCDAO-92 - the problem owner's roll-up of their postings. */

const mocks = vi.hoisted(() => ({ listOwnerDashboard: vi.fn(), listActionItems: vi.fn() }));
vi.mock("../../src/lib/proposalQueues.js", async (importOriginal) => ({
  ...(await importOriginal()),
  listOwnerDashboard: mocks.listOwnerDashboard,
  listActionItems: mocks.listActionItems,
}));
vi.mock("../../src/lib/firebase.js", () => ({ db: {}, functions: {}, auth: null }));
vi.mock("../../src/context/AuthContext.jsx", () => ({
  useAuth: () => ({ user: { id: `0x${"a".repeat(40)}`, org: "SMU" } }),
}));

import { OwnerDashboardPanel } from "../../src/components/OwnerDashboardPanel.jsx";

const render = (ui) => renderBare(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>,
);

const posting = (overrides = {}) => ({
  id: "p1",
  title: "Cold-chain routing",
  status: "submitted",
  workflowStatus: "submitted",
  opportunityType: "business-problem",
  expiresAt: "2099-01-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  currency: "SGD",
  requestedAmount: 5000,
  isDraft: false,
  live: true,
  proposalsReceived: 3,
  openSolutions: 3,
  fundedSolutions: 1,
  awaitingFeedback: 2,
  qualifyingRecommendations: 1,
  recommendationOutcomes: { recommend: 1, recommend_with_revisions: 0, do_not_recommend: 0 },
  recommendations: [{ proposalId: "s1", proposalTitle: "Annealing study", commentId: "c1",
    recommendation: "recommend", at: "2026-10-01T00:00:00.000Z" }],
  fundingCommitted: 125,
  fundingTarget: 300,
  fundingPercent: 42,
  readiness: { fundingMet: true, feedbackPresent: true, canSelect: true, blockers: [] },
  acceptedProposalId: null,
  ...overrides,
});

const dashboard = (overrides = {}) => ({
  postings: [posting()],
  accepted: [],
  blockers: [],
  totals: { postings: 1, drafts: 0, live: 1, closed: 0, proposalsReceived: 3, awaitingFeedback: 2,
    readyToSelect: 1, blockedPostings: 0, acceptedSolutions: 0 },
  truncated: {},
  generatedAt: "2026-10-03T09:00:00.000Z",
  ...overrides,
});

const EMPTY_ACTIONS = { total: 0, owner: { readyToSelect: [], awaitingReview: [] },
  researcher: { selectionToAccept: [], grantSelectionsToAccept: [] }, evaluator: null, escrowActions: [] };

beforeEach(() => {
  mocks.listOwnerDashboard.mockReset().mockResolvedValue(dashboard());
  mocks.listActionItems.mockReset().mockResolvedValue(EMPTY_ACTIONS);
});
afterEach(cleanup);

const card = () => screen.getByText("Cold-chain routing").closest(".rollup-card");

describe("QCDAO-92 problem owner dashboard", () => {
  it("rolls up solutions, funding and evaluator feedback for each posting", async () => {
    render(<OwnerDashboardPanel onNavigate={vi.fn()} />);
    await screen.findByText("Cold-chain routing");
    const row = within(card());
    expect(row.getByText("Solutions received").nextSibling.textContent).toBe("3");
    expect(row.getByText("Fully funded").nextSibling.textContent).toBe("1");
    expect(row.getByText("Awaiting feedback").nextSibling.textContent).toBe("2");
    // The posting's own requirement is shown beside the committed total, so one
    // is never read as the other.
    expect(row.getByText(/SGD 125 committed of SGD 300 asked/)).toBeTruthy();
    expect(row.getByText(/Posting requirement SGD 5,000/)).toBeTruthy();
  });

  it("says plainly whether selection can begin, and what is holding it shut", async () => {
    render(<OwnerDashboardPanel onNavigate={vi.fn()} />);
    await screen.findByText("Cold-chain routing");
    expect(within(card()).getByText(/Selection can begin/)).toBeTruthy();

    cleanup();
    mocks.listOwnerDashboard.mockResolvedValue(dashboard({
      postings: [posting({
        readiness: { fundingMet: false, feedbackPresent: false, canSelect: false, blockers: [
          { kind: "funding_short", owner: false, detail: "No solution has reached its funding target. Selection opens once one is fully funded." },
          { kind: "feedback_missing", owner: false, detail: "No evaluator recommendation has been filed. A decision needs at least one." },
        ] },
      })],
    }));
    render(<OwnerDashboardPanel onNavigate={vi.fn()} />);
    await screen.findByText("Cold-chain routing");
    expect(within(card()).getByText(/reached its funding target/)).toBeTruthy();
    expect(within(card()).getByText(/No evaluator recommendation has been filed/)).toBeTruthy();
    expect(within(card()).queryByText(/Selection can begin/)).toBeNull();
  });

  it("links each recommendation to the comment that carries it", async () => {
    const onNavigate = vi.fn();
    render(<OwnerDashboardPanel onNavigate={onNavigate} />);
    await screen.findByText("Cold-chain routing");
    // Twice on purpose: once as the posting's outcome mix, once per solution
    // with the link to the comment behind it.
    expect(within(card()).getAllByText("Evaluator · Recommend")).toHaveLength(2);
    fireEvent.click(within(card()).getByRole("button", { name: "Annealing study" }));
    expect(onNavigate).toHaveBeenCalledWith("proposal/s1?comment=c1");
  });

  it("deep-links into comparison, selection and the audit record", async () => {
    const onNavigate = vi.fn();
    render(<OwnerDashboardPanel onNavigate={onNavigate} />);
    await screen.findByText("Cold-chain routing");
    for (const [name, route] of [
      ["Solutions & comparison", "posting/p1?tab=proposals"],
      ["Selection & funding", "posting/p1?tab=funding"],
      ["Audit record", "posting/p1?tab=record"],
    ]) {
      fireEvent.click(within(card()).getByRole("button", { name }));
      expect(onNavigate).toHaveBeenCalledWith(route);
    }
  });

  it("separates work blocked on the owner from work blocked on someone else", async () => {
    mocks.listActionItems.mockResolvedValue({
      ...EMPTY_ACTIONS,
      total: 1,
      owner: { readyToSelect: [{ id: "s1", title: "Annealing study", problemId: "p1",
        posting: { id: "p1", title: "Cold-chain routing" }, submittedAt: "2026-10-01T00:00:00.000Z" }], awaitingReview: [] },
    });
    mocks.listOwnerDashboard.mockResolvedValue(dashboard({
      blockers: [{ postingId: "p2", postingTitle: "Scheduling", kind: "feedback_missing", owner: false,
        detail: "No evaluator recommendation has been filed. A decision needs at least one." }],
    }));
    render(<OwnerDashboardPanel onNavigate={vi.fn()} />);
    await screen.findByText("Waiting on someone else");
    expect(screen.getByText("Ready to select")).toBeTruthy();
    expect(screen.getByText("Postings ready to select")).toBeTruthy();
    // Named as not the owner's to fix: a blocker in the to-do list would read as
    // a reproach for work they cannot do.
    expect(screen.getByText(/Nothing here is yours to fix/)).toBeTruthy();
    expect(screen.getByText(/Evaluator feedback outstanding/)).toBeTruthy();
  });

  it("gives a new owner something to do instead of an empty grid", async () => {
    mocks.listOwnerDashboard.mockResolvedValue(dashboard({
      postings: [],
      totals: { postings: 0, drafts: 0, live: 0, closed: 0, proposalsReceived: 0, awaitingFeedback: 0,
        readyToSelect: 0, blockedPostings: 0, acceptedSolutions: 0 },
    }));
    const onNavigate = vi.fn();
    render(<OwnerDashboardPanel onNavigate={onNavigate} />);
    expect(await screen.findByRole("heading", { name: "No postings yet" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ New brief" }));
    expect(onNavigate).toHaveBeenCalledWith("create");
    expect(screen.getByText(/Nothing is blocked on you right now./)).toBeTruthy();
  });

  it("points a draft-only owner at their drafts rather than at an empty marketplace", async () => {
    mocks.listOwnerDashboard.mockResolvedValue(dashboard({
      postings: [posting({ isDraft: true, live: false, status: "draft", workflowStatus: "draft" })],
      totals: { postings: 1, drafts: 1, live: 0, closed: 0, proposalsReceived: 0, awaitingFeedback: 0,
        readyToSelect: 0, blockedPostings: 0, acceptedSolutions: 0 },
    }));
    render(<OwnerDashboardPanel onNavigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Nothing published yet" })).toBeTruthy();
  });

  it("lists accepted solutions with a route to their funding and record", async () => {
    mocks.listOwnerDashboard.mockResolvedValue(dashboard({
      accepted: [{ proposalId: "win", title: "Winning study", postingId: "p1", postingTitle: "Cold-chain routing",
        amount: 100, currency: "SGD", escrowBacked: true, acceptedAt: "2026-10-02T00:00:00.000Z" }],
      totals: { ...dashboard().totals, acceptedSolutions: 1 },
    }));
    const onNavigate = vi.fn();
    render(<OwnerDashboardPanel onNavigate={onNavigate} />);
    await screen.findByText("Winning study");
    const row = screen.getByText("Winning study").closest(".table-row");
    expect(within(row).getByText(/Escrow-backed/)).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Audit record" }));
    expect(onNavigate).toHaveBeenCalledWith("proposal/win?tab=record");
  });

  it("says a count is partial rather than showing a confident wrong total", async () => {
    mocks.listOwnerDashboard.mockResolvedValue(dashboard({ truncated: { postings: true, proposals: false } }));
    render(<OwnerDashboardPanel onNavigate={vi.fn()} />);
    await screen.findByText("Cold-chain routing");
    expect(screen.getByText(/The real totals are higher/)).toBeTruthy();
  });

  it("never claims a grant posting is blocked on funding it cannot read", async () => {
    mocks.listOwnerDashboard.mockResolvedValue(dashboard({
      postings: [posting({ opportunityType: "open-funding",
        readiness: { fundingMet: false, feedbackPresent: false, canSelect: false, blockers: [] } })],
    }));
    const onNavigate = vi.fn();
    render(<OwnerDashboardPanel onNavigate={onNavigate} />);
    await screen.findByText("Cold-chain routing");
    expect(within(card()).getByText(/held in this opportunity's on-chain pool/)).toBeTruthy();
    fireEvent.click(within(card()).getByRole("button", { name: "Grant funding" }));
    expect(onNavigate).toHaveBeenCalledWith("posting/p1?tab=funding");
  });

  it("reports a failed load instead of an empty dashboard", async () => {
    mocks.listOwnerDashboard.mockRejectedValue(Object.assign(new Error("nope"), { code: "unauthenticated" }));
    render(<OwnerDashboardPanel onNavigate={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Sign in again/);
  });
});
