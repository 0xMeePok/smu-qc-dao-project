import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "owner" },
  read: vi.fn(),
  select: vi.fn(),
  find: vi.fn(),
  comments: vi.fn(),
}));

vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../src/lib/firebase.js", () => ({ functions: {}, db: {} }));
vi.mock("../../src/lib/proposalComparison.js", async (importOriginal) => ({
  ...await importOriginal(),
  getProposalComparison: (...args) => mocks.read(...args),
}));
vi.mock("../../src/lib/matching.js", async (importOriginal) => ({
  ...await importOriginal(),
  selectMockProposal: (...args) => mocks.select(...args),
}));
vi.mock("../../src/lib/proposals.js", () => ({ findProposal: (...args) => mocks.find(...args) }));
vi.mock("../../src/lib/moderation.js", () => ({ listReportableComments: (...args) => mocks.comments(...args) }));

import { ProposalComparison } from "../../src/components/ProposalComparison.jsx";
import { proposalFundingStatus } from "../../src/lib/matching.js";

const row = (overrides = {}) => ({
  id: "alpha",
  title: "Alpha annealing",
  developerName: "Alice Researcher",
  organisation: "SMU",
  category: "quantum-annealing",
  amount: 100,
  currency: "SGD",
  status: "submitted",
  fundedAmount: 100,
  matching: { status: "funding", evaluationComplete: true },
  recommendations: { recommend: 0, recommend_with_revisions: 1, do_not_recommend: 0 },
  qualifyingCount: 1,
  commentCount: 2,
  canSelect: true,
  selectionHint: null,
  ...overrides,
});

const comparison = (overrides = {}) => ({
  problemId: "problem",
  viewerIsOwner: true,
  advisory: true,
  truncated: false,
  problemMatching: { status: "open", proposalId: null },
  rows: [
    row(),
    row({
      id: "bravo",
      title: "Bravo routes",
      developerName: "Bob Developer",
      organisation: "Quantum Lab",
      category: "hybrid",
      amount: 40,
      recommendations: { recommend: 1, recommend_with_revisions: 0, do_not_recommend: 0 },
      qualifyingCount: 1,
      commentCount: 1,
      canSelect: false,
      selectionHint: "Needs full funding.",
    }),
  ],
  ...overrides,
});

beforeEach(() => {
  mocks.user = { id: "owner" };
  mocks.read.mockReset().mockResolvedValue(comparison());
  mocks.select.mockReset().mockResolvedValue({});
  mocks.find.mockReset().mockResolvedValue({
    id: "alpha",
    title: "Alpha annealing",
    summary: "Anneal the stops.",
    methodology: "Compare with a classical baseline.",
    status: "submitted",
    opportunityType: "business-problem",
    attachments: [],
  });
  mocks.comments.mockReset().mockResolvedValue({ items: [{
    id: "comment-1",
    authorName: "Ada",
    authorRole: "evaluator",
    badge: "evaluator",
    qualifying: true,
    recommendation: "recommend_with_revisions",
    body: "Tighten the benchmark.",
    createdAt: "2026-09-01T00:00:00.000Z",
    replies: [],
  }] });
});
afterEach(cleanup);

describe("proposal comparison", () => {
  it("[FUT-SPE-160] shows comparison fields and no score or reward-grade field", async () => {
    render(<ProposalComparison problemId="problem" />);
    expect(await screen.findByRole("radiogroup", { name: "Choose the proposal to match" })).toBeTruthy();
    expect(screen.getAllByText("Evaluators")).toHaveLength(2);
    expect(screen.queryByText(/do not rank these proposals or choose a winner/)).toBeNull();
    const fields = [...document.querySelectorAll(".comparison-metrics dt")].map((term) => term.textContent);
    expect(fields.some((field) => /score|grade|reward/i.test(field))).toBe(false);
    expect(screen.getAllByRole("button", { name: "Go to proposal" })).toHaveLength(2);
    expect(screen.getByText("1 Recommend with revisions")).toBeTruthy();
    expect(screen.queryByText(/0 Recommend/)).toBeNull();
  });

  it("[FUT-SPE-161] lets the owner select an eligible proposal and records the rationale", async () => {
    const selected = vi.fn();
    mocks.read.mockResolvedValueOnce(comparison()).mockResolvedValue(comparison({
      rows: [row({ canSelect: false, selectionHint: null, matching: { status: "awaiting_confirmation" } })],
    }));
    render(<ProposalComparison problemId="problem" onSelected={selected} />);
    fireEvent.click(await screen.findByRole("radio", { name: "Select Alpha annealing" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm match" }));
    const dialog = screen.getByRole("dialog", { name: "Select this proposal?" });
    fireEvent.change(within(dialog).getByLabelText("Selection rationale"), { target: { value: "short" } });
    fireEvent.submit(dialog.querySelector("form"));
    expect(screen.getByRole("alert").textContent).toContain("at least 10 characters");
    expect(mocks.select).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("Selection rationale"), { target: { value: "This approach meets the posted constraints." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Select and accept" }));
    await screen.findByText("Awaiting creator acceptance");
    expect(mocks.select).toHaveBeenCalledWith({
      problemId: "problem", proposalId: "alpha", rationale: "This approach meets the posted constraints.",
    });
    expect(selected).toHaveBeenCalled();
  });

  it("lets the owner select a fully funded proposal without evaluator feedback", async () => {
    mocks.read.mockResolvedValue(comparison({
      rows: [row({ matching: { status: "funding", evaluationComplete: false },
        recommendations: { recommend: 0, recommend_with_revisions: 0, do_not_recommend: 0 },
        qualifyingCount: 0, commentCount: 0 })],
    }));
    render(<ProposalComparison problemId="problem" />);
    expect((await screen.findByRole("radio", { name: "Select Alpha annealing" })).disabled).toBe(false);
    expect(screen.getByText("No qualifying recommendation")).toBeTruthy();
    expect(screen.getByText(/recommendations are optional and advisory/)).toBeTruthy();
    expect(screen.queryByText(/Needs a qualifying evaluator recommendation/)).toBeNull();
  });

  it("[FUT-SPE-162] shows selection only to the owner after the funding gate is open", async () => {
    mocks.user = { id: "funder" };
    mocks.read.mockResolvedValue(comparison({
      viewerIsOwner: false,
      rows: [row({ canSelect: false, selectionHint: null }), row({ id: "bravo", title: "Bravo routes", canSelect: false, selectionHint: null })],
    }));
    render(<ProposalComparison problemId="problem" />);
    await screen.findByRole("button", { name: "Show details for Alpha annealing" });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByText(/Needs full funding/)).toBeNull();
  });

  it("[FUT-SPE-163] filters by recommendation outcome and sorts by requested funding", async () => {
    render(<ProposalComparison problemId="problem" />);
    expect((await screen.findByRole("radio", { name: "Select Alpha annealing" })).disabled).toBe(false);
    expect(screen.getByRole("radio", { name: "Select Bravo routes" }).disabled).toBe(true);
    expect(screen.getByText("Needs full funding.")).toBeTruthy();
    const filters = screen.getByRole("group", { name: "Filter by evaluator recommendation" });
    fireEvent.click(within(filters).getByRole("button", { name: "Recommend" }));
    expect(screen.queryByRole("button", { name: "Show details for Alpha annealing" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show details for Bravo routes" })).toBeTruthy();
    fireEvent.click(within(filters).getByRole("button", { name: "All" }));
    fireEvent.change(screen.getByLabelText(/^Sort/), { target: { value: "amount:asc" } });
    const titles = screen.getAllByRole("button", { name: /^Show details for / }).map((button) => button.getAttribute("aria-label"));
    expect(titles).toEqual(["Show details for Bravo routes", "Show details for Alpha annealing"]);
  });

  it("[FUT-SPE-164] expands a row to the proposal text and evaluator-badged comments", async () => {
    render(<ProposalComparison problemId="problem" />);
    fireEvent.click(await screen.findByRole("button", { name: "Show details for Alpha annealing" }));
    const detail = (await screen.findByText("Compare with a classical baseline.")).closest(".comparison-detail");
    expect(within(detail).getByText("Tighten the benchmark.")).toBeTruthy();
    expect(within(detail).getByText("Recommend with revisions")).toBeTruthy();
    expect(within(detail).getByText("Evaluator")).toBeTruthy();
    expect(mocks.comments).toHaveBeenCalledWith({ proposalId: "alpha" });
  });

  it("shows funding status as a short, toned status with its consequence as a note", async () => {
    mocks.read.mockResolvedValue(comparison({
      rows: [row({ canSelect: false, selectionHint: null, matching: { status: "declined" } })],
    }));
    const { container } = render(<ProposalComparison problemId="problem" />);
    await screen.findByRole("button", { name: "Show details for Alpha annealing" });
    const pill = container.querySelector(".funding-pill");
    expect(pill.textContent).toBe("Declined");
    expect(pill.className).toContain("tone-neutral");
    expect(container.querySelector(".funding-status small").textContent).toBe("Funders refunded");
    expect(container.textContent).not.toContain("Rejected");
  });
});

describe("proposalFundingStatus", () => {
  const status = (proposal, problemMatching) => proposalFundingStatus({ id: "p", amount: 100, ...proposal }, problemMatching);
  it("splits every label into a headline, a note and a tone", () => {
    expect(status({ matching: { status: "declined" } })).toEqual({ label: "Declined", detail: "Funders refunded", tone: "neutral" });
    expect(status({ matching: { status: "cancelled" } })).toEqual({ label: "Cancelled", detail: "Funders refunded", tone: "neutral" });
    expect(status({ matching: { status: "confirmed" } })).toEqual({ label: "Matched", detail: "Funding locked", tone: "success" });
    expect(status({ matching: { status: "awaiting_confirmation" } })).toEqual({ label: "Awaiting creator acceptance", detail: "", tone: "warning" });
    expect(status({ fundedAmount: 100 })).toEqual({ label: "Fully funded", detail: "Awaiting owner selection", tone: "success" });
    expect(status({ fundedAmount: 10 })).toEqual({ label: "Open for funding", detail: "", tone: "warning" });
    expect(status({}, { status: "confirmed" })).toEqual({ label: "Not selected", detail: "Funders refunded", tone: "neutral" });
    expect(status({}, { status: "awaiting_confirmation", proposalId: "other" })).toEqual({ label: "Paused", detail: "Another proposal selected", tone: "warning" });
    expect(status({ status: "withdrawn" })).toEqual({ label: "Withdrawn", detail: "", tone: "neutral" });
  });
});
