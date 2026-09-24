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
  it("[FUT-SPE-160] shows comparison columns and no score or reward-grade column", async () => {
    render(<ProposalComparison problemId="problem" />);
    expect(await screen.findByRole("columnheader", { name: "Evaluator recommendation" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Decision" })).toBeTruthy();
    expect(screen.queryByText(/do not rank these proposals or choose a winner/)).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /score|grade|reward/i })).toBeNull();
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
    fireEvent.click(await screen.findByRole("button", { name: "Select Alpha annealing" }));
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

  it("[FUT-SPE-162] shows selection only to the owner after both gates are open", async () => {
    mocks.user = { id: "funder" };
    mocks.read.mockResolvedValue(comparison({
      viewerIsOwner: false,
      rows: [row({ canSelect: false, selectionHint: null }), row({ id: "bravo", title: "Bravo routes", canSelect: false, selectionHint: null })],
    }));
    render(<ProposalComparison problemId="problem" />);
    await screen.findByRole("button", { name: "Show details for Alpha annealing" });
    expect(screen.queryByRole("columnheader", { name: "Decision" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Select / })).toBeNull();
    expect(screen.queryByText(/Needs full funding/)).toBeNull();
  });

  it("[FUT-SPE-163] filters by recommendation outcome and sorts by requested funding", async () => {
    render(<ProposalComparison problemId="problem" />);
    await screen.findByRole("button", { name: "Select Alpha annealing" });
    expect(screen.queryByRole("button", { name: "Select Bravo routes" })).toBeNull();
    expect(screen.getByText("Needs full funding.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Filter by evaluator recommendation/), { target: { value: "recommend" } });
    expect(screen.queryByRole("button", { name: "Show details for Alpha annealing" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show details for Bravo routes" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Filter by evaluator recommendation/), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(/^Sort/), { target: { value: "amount:asc" } });
    const titles = screen.getAllByRole("button", { name: /^Show details for / }).map((button) => button.getAttribute("aria-label"));
    expect(titles).toEqual(["Show details for Bravo routes", "Show details for Alpha annealing"]);
  });

  it("[FUT-SPE-164] expands a row to the proposal text and evaluator-badged comments", async () => {
    render(<ProposalComparison problemId="problem" />);
    fireEvent.click(await screen.findByRole("button", { name: "Show details for Alpha annealing" }));
    const detail = (await screen.findByText("Compare with a classical baseline.")).closest("td");
    expect(within(detail).getByText("Tighten the benchmark.")).toBeTruthy();
    expect(within(detail).getByText("Recommend with revisions")).toBeTruthy();
    expect(within(detail).getByText("Evaluator")).toBeTruthy();
    expect(mocks.comments).toHaveBeenCalledWith({ proposalId: "alpha" });
  });
});
