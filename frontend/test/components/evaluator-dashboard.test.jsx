import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listEvaluatorQueue: vi.fn() }));
vi.mock("../../src/lib/proposalQueues.js", async () => {
  const actual = await vi.importActual("../../src/lib/proposalQueues.js");
  return { ...actual, listEvaluatorQueue: mocks.listEvaluatorQueue };
});
vi.mock("../../src/lib/firebase.js", () => ({ db: {}, functions: {}, auth: {} }));

import { EvaluatorQueue } from "../../src/components/RoleViews.jsx";

const row = (overrides = {}) => ({
  id: "proposal-1",
  title: "Annealing routing study",
  status: "submitted",
  workflowStatus: "submitted",
  submittedAt: "2026-10-01T00:00:00.000Z",
  posting: { id: "posting-1", title: "Routing challenge", expiresAt: "2099-01-01T00:00:00.000Z", status: "open" },
  recommendationStatus: "pending",
  recommendation: null,
  recommendations: {},
  gatesSelection: true,
  needsAttention: false,
  attentionReason: null,
  ...overrides,
});

const queue = (items) => mocks.listEvaluatorQueue.mockResolvedValue({ items, filter: "pending", nextCursor: null });

beforeEach(() => { mocks.listEvaluatorQueue.mockReset(); });
afterEach(cleanup);

describe("QCDAO-95 evaluator feedback dashboard", () => {
  it("states what a recommendation actually is before asking for one", async () => {
    queue([row()]);
    render(<EvaluatorQueue onNavigate={vi.fn()} />);
    await screen.findByText("Annealing routing study");
    // The three outcomes and the Evaluator badge are the whole contract of the
    // task; an evaluator should not have to open a proposal to learn it.
    const hint = screen.getByText(/Evaluator badge and exactly one outcome/);
    expect(hint.textContent).toMatch(/Recommend, Recommend with revisions, or Do not recommend/);
    expect(hint.textContent).toMatch(/A reply does not count/);
  });

  it("names the solutions whose missing feedback is holding a selection shut", async () => {
    queue([row(), row({ id: "proposal-2", title: "Already recommended", gatesSelection: false })]);
    render(<EvaluatorQueue onNavigate={vi.fn()} />);
    await screen.findByText("Annealing routing study");
    const gated = screen.getByText("Annealing routing study").closest(".table-row");
    expect(within(gated).getByText(/the owner cannot take this solution to a decision/)).toBeTruthy();
    const open = screen.getByText("Already recommended").closest(".table-row");
    expect(within(open).queryByText(/cannot take this solution to a decision/)).toBeNull();
  });

  it("explains a moderated-away recommendation rather than quietly re-queuing it", async () => {
    queue([row({ needsAttention: true, attentionReason: "removed", filedRecommendation: "recommend" })]);
    render(<EvaluatorQueue onNavigate={vi.fn()} />);
    const item = (await screen.findByText("Annealing routing study")).closest(".table-row");
    expect(within(item).getByText(/removed by moderation/)).toBeTruthy();
    // The outcome that was filed is named, so the evaluator knows what was taken down.
    expect(item.textContent).toMatch(/recommend filing is not counted/i);
    expect(item.textContent).toMatch(/File a new one to replace it/);
    // Not colour alone: the row itself is marked.
    expect(item.className).toMatch(/table-row-attention/);
  });

  it("does not claim a gate is blocked when the real problem is the evaluator's own filing", async () => {
    queue([row({ needsAttention: true, attentionReason: "deleted", filedRecommendation: "do_not_recommend" })]);
    render(<EvaluatorQueue onNavigate={vi.fn()} />);
    const item = (await screen.findByText("Annealing routing study")).closest(".table-row");
    expect(within(item).getByText(/You deleted your recommendation/)).toBeTruthy();
    expect(within(item).queryByText(/the owner cannot take this solution/)).toBeNull();
  });

  it("shows my own outcome on a filing that still counts", async () => {
    queue([row({ recommendationStatus: "submitted", recommendation: "recommend_with_revisions", gatesSelection: false })]);
    render(<EvaluatorQueue onNavigate={vi.fn()} />);
    const item = (await screen.findByText("Annealing routing study")).closest(".table-row");
    expect(item.textContent).toMatch(/My recommendation/);
    expect(item.className).not.toMatch(/table-row-attention/);
  });
});
