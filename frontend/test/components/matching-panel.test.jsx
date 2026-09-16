import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: { id: "owner" }, read: vi.fn(), fund: vi.fn(), select: vi.fn(), confirm: vi.fn(), portfolio: vi.fn(), decline: vi.fn(), evaluate: vi.fn(), expire: vi.fn() }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../src/lib/firebase.js", () => ({ functions: {} }));
vi.mock("../../src/lib/matching.js", async (importOriginal) => ({
  ...await importOriginal(),
  getMockMatching: (...args) => mocks.read(...args),
  fundMockProposal: (...args) => mocks.fund(...args),
  selectMockProposal: (...args) => mocks.select(...args),
  confirmMockProposal: (...args) => mocks.confirm(...args),
  getMockFundingPortfolio: (...args) => mocks.portfolio(...args),
  declineMockProposal: (...args) => mocks.decline(...args),
  completeMockEvaluation: (...args) => mocks.evaluate(...args),
  forceExpireMockMatch: (...args) => mocks.expire(...args),
}));
import { MatchingPanel } from "../../src/components/MatchingPanel.jsx";
import { MockFundingPortfolio } from "../../src/components/MockFundingPortfolio.jsx";

const candidate = (overrides = {}) => ({ id: "proposal-1", title: "Quantum routing", currency: "USD", amount: 100, fundedAmount: 100, matching: { status: "funding" }, canFund: false, canSelect: true, canConfirm: false, ...overrides });
const snapshot = (overrides = {}) => ({ matching: { status: "funding" }, proposals: [candidate()], contributions: [], ...overrides });
const waiting = (overrides = {}) => snapshot({ matching: { status: "awaiting_confirmation", deadlineAt: "2099-09-22T00:00:00Z" }, ...overrides });
const submit = () => fireEvent.submit(screen.getByRole("dialog").querySelector("form"));

beforeEach(() => {
  mocks.user = { id: "owner" };
  mocks.read.mockReset().mockResolvedValue(snapshot());
  mocks.fund.mockReset().mockResolvedValue({});
  mocks.select.mockReset().mockResolvedValue({});
  mocks.confirm.mockReset().mockResolvedValue({});
  mocks.portfolio.mockReset().mockResolvedValue({ contributions: [] });
  mocks.decline.mockReset().mockResolvedValue({});
  mocks.evaluate.mockReset().mockResolvedValue({});
  mocks.expire.mockReset().mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("server-backed mock funding and mutual matching", () => {
  it("renders nothing when the linked problem is unavailable", () => {
    const { container } = render(<MatchingPanel />);
    expect(container.textContent).toBe("");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("does not fetch or expose actions without a signed-in account", () => {
    mocks.user = null;
    const { container } = render(<MatchingPanel problemId="problem-1" />);
    expect(container.textContent).toBe("");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("requires the owner's explicit approval in a selection dialog", async () => {
    mocks.read.mockResolvedValueOnce(snapshot()).mockResolvedValue(waiting());
    const changed = vi.fn();
    render(<MatchingPanel problemId="problem-1" onChange={changed} />);
    fireEvent.click(await screen.findByRole("button", { name: "Select proposal" }));
    const dialog = screen.getByRole("dialog", { name: "Select this proposal?" });
    expect(within(dialog).getByText(/seven-day confirmation window/)).toBeTruthy();
    expect(mocks.select).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Selection rationale"), { target: { value: "Best technical fit for the problem." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Select and start seven days" }));
    await screen.findByText("Waiting for the selected creator");
    expect(mocks.select).toHaveBeenCalledWith({ problemId: "problem-1", proposalId: "proposal-1", rationale: "Best technical fit for the problem." });
    expect(changed).toHaveBeenLastCalledWith(waiting());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("only exposes the capabilities granted by the server for this viewer", async () => {
    mocks.read.mockResolvedValue(snapshot({ proposals: [candidate({ canSelect: false })] }));
    render(<MatchingPanel problemId="problem-1" />);
    await screen.findByRole("heading", { name: "Quantum routing" });
    expect(screen.queryByRole("button", { name: "Select proposal" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Confirm I will work/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fund proposal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Complete mock evaluation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expire window for demonstration" })).toBeNull();
  });

  it("requires at least ten non-whitespace rationale characters before owner selection", async () => {
    render(<MatchingPanel problemId="problem-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Select proposal" }));
    fireEvent.change(screen.getByLabelText("Selection rationale"), { target: { value: "  short  " } });
    submit();
    expect(screen.getByRole("alert").textContent).toContain("at least 10 characters");
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("requires a creator's decline reason and shows the refund result", async () => {
    mocks.user = { id: "creator" };
    mocks.read.mockResolvedValueOnce(waiting({ proposals: [candidate({ canSelect: false, canConfirm: true })] }))
      .mockResolvedValue(snapshot({ proposals: [candidate({ canSelect: false, matching: { status: "voided" } })] }));
    render(<MatchingPanel problemId="problem-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Decline selection" }));
    expect(screen.getByRole("dialog", { name: "Decline this selection?" })).toBeTruthy();
    submit();
    expect(screen.getByRole("alert").textContent).toContain("at least 10 characters");
    expect(mocks.decline).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Reason for declining"), { target: { value: "  Team capacity is no longer available.  " } });
    submit();
    await screen.findByText(/Selection declined. Your funders are refunded/);
    expect(mocks.decline).toHaveBeenCalledWith({ problemId: "problem-1", proposalId: "proposal-1", reason: "Team capacity is no longer available." });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lets an authorized administrator complete the mock evaluation gate explicitly", async () => {
    mocks.user = { id: "admin" };
    mocks.read.mockResolvedValueOnce(snapshot({ proposals: [candidate({ canSelect: false, canCompleteEvaluation: true })] }))
      .mockResolvedValue(snapshot({ proposals: [candidate({ canSelect: false, matching: { status: "funding", evaluationComplete: true } })] }));
    render(<MatchingPanel problemId="problem-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete mock evaluation" }));
    expect(screen.getByRole("dialog", { name: "Complete mock expert evaluation?" })).toBeTruthy();
    expect(screen.getByText(/This is a simulated evaluation/)).toBeTruthy();
    expect(mocks.evaluate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Record mock evaluation" }));
    await screen.findByText(/Mock expert evaluation completed/);
    expect(mocks.evaluate).toHaveBeenCalledWith({ problemId: "problem-1", proposalId: "proposal-1" });
    expect(screen.getByText(/Expert evaluation: Complete/)).toBeTruthy();
  });

  it("requires explicit administrator confirmation to expire a demo window", async () => {
    mocks.read.mockResolvedValueOnce(waiting({ canForceExpire: true }))
      .mockResolvedValue(snapshot({ proposals: [candidate({ canSelect: false, matching: { status: "voided" } })] }));
    render(<MatchingPanel problemId="problem-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Expire window for demonstration" }));
    expect(screen.getByRole("dialog", { name: "Expire this window now?" })).toBeTruthy();
    expect(mocks.expire).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Expire and refund" }));
    await screen.findByText(/confirmation window was expired for this demonstration/);
    expect(mocks.expire).toHaveBeenCalledWith({ problemId: "problem-1" });
    expect(screen.getByText("Voided · funders refunded")).toBeTruthy();
  });

  it("renders owner approval and the server decision record with actor, reason and reference", async () => {
    mocks.read.mockResolvedValue(waiting({
      matching: { status: "awaiting_confirmation", ownerApprovedBy: "owner-123", ownerApprovedAt: "2026-09-15T00:00:00Z", rationale: "The strongest technical fit.", deadlineAt: "2099-09-22T00:00:00Z" },
      history: [{ id: "decision-123", type: "proposal_selected", actorId: "owner-123", proposalId: "proposal-1", reason: "The strongest technical fit.", createdAt: "2026-09-15T00:00:00Z" }], historyTruncated: true,
    }));
    render(<MatchingPanel problemId="problem-1" />);
    await screen.findByRole("heading", { name: "Decision record" });
    expect(screen.getByText("Problem owner approved")).toBeTruthy();
    expect(screen.getByText("Awaiting creator response")).toBeTruthy();
    const record = document.getElementById("matching-event-decision-123");
    expect(within(record).getByText("owner-123")).toBeTruthy();
    expect(within(record).getByText("The strongest technical fit.")).toBeTruthy();
    expect(within(record).getByText("decision-123")).toBeTruthy();
    expect(screen.getByText("Showing the latest 100 events.")).toBeTruthy();
  });

  it("pauses all sibling funding and selection during the seven-day window", async () => {
    mocks.read.mockResolvedValue(waiting({ proposals: [candidate({ canSelect: true, canFund: true }), candidate({ id: "proposal-2", title: "Another approach", fundedAmount: 20, canFund: true })] }));
    render(<MatchingPanel problemId="problem-1" />);
    await screen.findByText("Waiting for the selected creator");
    expect(screen.getByText(/Funding is paused for every proposal/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fund proposal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Select proposal" })).toBeNull();
  });

  it("lets the selected creator confirm locking and sibling refunds explicitly", async () => {
    mocks.user = { id: "creator" };
    mocks.read.mockResolvedValueOnce(waiting({ proposals: [candidate({ canSelect: false, canConfirm: true })] }))
      .mockResolvedValue(snapshot({ matching: { status: "confirmed" }, proposals: [candidate({ canSelect: false, matching: { status: "confirmed" } })] }));
    render(<MatchingPanel problemId="problem-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm I will work on this problem" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm this match?" });
    expect(within(dialog).getByText(/All other proposals on this problem will be cancelled/)).toBeTruthy();
    expect(mocks.confirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm and lock funding" }));
    await screen.findByText(/Both parties approved/);
    expect(mocks.confirm).toHaveBeenCalledWith({ problemId: "problem-1", proposalId: "proposal-1" });
    expect(screen.queryByRole("button", { name: /Confirm I will work/ })).toBeNull();
  });

  it("shows timeout refunds and resumes surviving proposals after server refresh", async () => {
    mocks.read.mockResolvedValueOnce(waiting()).mockResolvedValue(snapshot({
      proposals: [candidate({ canSelect: false, matching: { status: "voided" } }), candidate({ id: "proposal-2", title: "Another approach", fundedAmount: 20, canSelect: false, canFund: true })],
      contributions: [{ id: "pledge", proposalId: "proposal-1", amount: 100, currency: "USD", status: "refunded" }],
    }));
    render(<MatchingPanel problemId="problem-1" />);
    await screen.findByText("Waiting for the selected creator");
    fireEvent.click(screen.getByRole("button", { name: "Refresh funding status" }));
    await screen.findByText("Voided · funders refunded");
    expect(screen.getByText("USD 100 · Refunded to you")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Fund proposal" })).toHaveLength(1);
    expect(screen.queryByText("Waiting for the selected creator")).toBeNull();
  });

  it.each(["0", "-1", "80.01", "1.001", ""])('rejects invalid amount "%s" without calling the server', async (value) => {
    mocks.read.mockResolvedValue(snapshot({ proposals: [candidate({ fundedAmount: 20, canSelect: false, canFund: true })] }));
    render(<MatchingPanel problemId="problem-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Fund proposal" }));
    fireEvent.change(screen.getByLabelText("Amount (USD)"), { target: { value } });
    submit();
    expect(screen.getByRole("alert").textContent).toContain("above zero and up to USD 80");
    expect(mocks.fund).not.toHaveBeenCalled();
  });

  it("reuses the contribution request ID after a failed response and ignores duplicate submissions", async () => {
    let resolveContribution;
    mocks.read.mockResolvedValue(snapshot({ proposals: [candidate({ fundedAmount: 20, canSelect: false, canFund: true })] }));
    mocks.fund.mockRejectedValueOnce(new Error("Network disconnected"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveContribution = resolve; }));
    render(<MatchingPanel problemId="problem-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Fund proposal" }));
    fireEvent.change(screen.getByLabelText("Amount (USD)"), { target: { value: "25.50" } });
    submit();
    await screen.findByRole("alert");
    const firstPayload = mocks.fund.mock.calls[0][0];
    expect(firstPayload).toMatchObject({ problemId: "problem-1", proposalId: "proposal-1", amount: 25.5 });
    expect(firstPayload.requestId).toEqual(expect.any(String));
    submit(); submit();
    expect(mocks.fund).toHaveBeenCalledTimes(2);
    expect(mocks.fund.mock.calls[1][0]).toEqual(firstPayload);
    await act(async () => { resolveContribution({}); });
    await screen.findByText("Mock contribution recorded.");
  });

  it("uses a different request ID when the funder changes the amount after a failure", async () => {
    mocks.read.mockResolvedValue(snapshot({ proposals: [candidate({ fundedAmount: 20, canSelect: false, canFund: true })] }));
    mocks.fund.mockRejectedValue(new Error("Network disconnected"));
    render(<MatchingPanel problemId="problem-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Fund proposal" }));
    submit(); await screen.findByRole("alert");
    const first = mocks.fund.mock.calls[0][0];
    fireEvent.change(screen.getByLabelText("Amount (USD)"), { target: { value: "12" } });
    submit();
    await waitFor(() => expect(mocks.fund).toHaveBeenCalledTimes(2));
    expect(mocks.fund.mock.calls[1][0].requestId).not.toBe(first.requestId);
    expect(mocks.fund.mock.calls[1][0].amount).toBe(12);
  });

  it("keeps the latest visible state and offers retry when refreshing fails", async () => {
    mocks.read.mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(snapshot());
    render(<MatchingPanel problemId="problem-1" />);
    await screen.findByRole("heading", { name: "Quantum routing" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh funding status" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Check your connection and retry");
    expect(screen.getByRole("heading", { name: "Quantum routing" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh funding status" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows only the current proposal and its contributions on proposal detail", async () => {
    mocks.read.mockResolvedValue(snapshot({ proposals: [candidate(), candidate({ id: "proposal-2", title: "Other approach" })], contributions: [
      { id: "one", proposalId: "proposal-1", amount: 10, currency: "USD", status: "pledged" },
      { id: "two", proposalId: "proposal-2", amount: 20, currency: "USD", status: "pledged" },
    ] }));
    render(<MatchingPanel problemId="problem-1" proposalId="proposal-1" />);
    await screen.findByText("USD 10 · Pledged");
    expect(mocks.read).toHaveBeenCalledWith("problem-1", { proposalId: "proposal-1", cursor: null });
    expect(screen.queryByText("USD 20 · Pledged")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Other approach" })).toBeNull();
  });

  it("ignores a previous problem's delayed response after navigating", async () => {
    let resolveOld;
    mocks.read.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue(snapshot({ proposals: [candidate({ title: "New problem proposal" })] }));
    const changed = vi.fn();
    const { rerender } = render(<MatchingPanel problemId="old-problem" onChange={changed} />);
    rerender(<MatchingPanel problemId="new-problem" onChange={changed} />);
    await screen.findByRole("heading", { name: "New problem proposal" });
    await act(async () => { resolveOld(snapshot()); });
    expect(screen.queryByRole("heading", { name: "Quantum routing" })).toBeNull();
    expect(screen.getByRole("heading", { name: "New problem proposal" })).toBeTruthy();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("does not let a delayed background poll overwrite a completed selection", async () => {
    vi.useFakeTimers();
    let resolvePoll;
    mocks.read.mockResolvedValueOnce(snapshot())
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }))
      .mockResolvedValue(waiting());
    await act(async () => { render(<MatchingPanel problemId="problem-1" />); });
    await act(async () => { vi.advanceTimersByTime(30_000); });
    fireEvent.click(screen.getByRole("button", { name: "Select proposal" }));
    fireEvent.change(screen.getByLabelText("Selection rationale"), { target: { value: "Best technical fit for the problem." } });
    await act(async () => { submit(); });
    expect(screen.getByText("Waiting for the selected creator")).toBeTruthy();
    await act(async () => { resolvePoll(snapshot()); });
    expect(screen.getByText("Waiting for the selected creator")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select proposal" })).toBeNull();
  });

  it("loads the next proposal page and can return to the first page", async () => {
    mocks.read.mockResolvedValueOnce(snapshot({ nextCursor: "proposal-50" }))
      .mockResolvedValueOnce(snapshot({ proposals: [candidate({ id: "proposal-51", title: "Later proposal" })] }))
      .mockResolvedValue(snapshot());
    render(<MatchingPanel problemId="problem-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Next proposals" }));
    await screen.findByRole("heading", { name: "Later proposal" });
    expect(mocks.read).toHaveBeenLastCalledWith("problem-1", { proposalId: undefined, cursor: "proposal-50" });
    expect(screen.queryByRole("heading", { name: "Quantum routing" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "First proposals" }));
    await screen.findByRole("heading", { name: "Quantum routing" });
    expect(mocks.read).toHaveBeenLastCalledWith("problem-1", { proposalId: undefined, cursor: null });
  });
});

describe("mock funding portfolio", () => {
  it("shows pledged, locked and refunded entries with reasons and problem navigation", async () => {
    mocks.portfolio.mockResolvedValue({ contributions: ["pledged", "locked", "refunded"].map((status) => ({ id: status, title: `${status} proposal`, status, currency: "USD", amount: 25, problemId: "problem-1", createdAt: "2026-09-15T00:00:00Z", ...(status === "refunded" ? { refundReason: "confirmation_expired", settledAt: "2026-09-22T00:00:00Z" } : {}) })) });
    const navigate = vi.fn();
    render(<MockFundingPortfolio onNavigate={navigate} />);
    await screen.findByText("refunded proposal");
    expect(screen.getByText(/USD 25 · Pledged/)).toBeTruthy();
    expect(screen.getByText(/USD 25 · Locked/)).toBeTruthy();
    expect(screen.getByText(/USD 25 · Refunded/)).toBeTruthy();
    expect(screen.getByText("Returned to you as mock funds · confirmation expired")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "View problem" })[0]);
    expect(navigate).toHaveBeenCalledWith("posting/problem-1");
  });

  it("allows retry after a portfolio read error and then shows browse navigation", async () => {
    mocks.portfolio.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ contributions: [] });
    const navigate = vi.fn();
    render(<MockFundingPortfolio onNavigate={navigate} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(await screen.findByRole("button", { name: "Browse opportunities to fund" }));
    expect(navigate).toHaveBeenCalledWith("discover");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

it.each(['funding_contributed', 'funding_target_reached'])('labels redacted %s actors as private contributors', async (type) => {
  mocks.read.mockResolvedValue(waiting({ history: [{ id: 'private-funding', type, actorId: null, proposalId: 'proposal-1', createdAt: '2026-09-15T00:00:00Z' }] }));
  render(<MatchingPanel problemId="problem-1" />);
  await screen.findByRole('heading', { name: 'Decision record' });
  const record = document.getElementById('matching-event-private-funding');
  expect(within(record).getByText('Private contributor')).toBeTruthy();
  expect(within(record).queryByText('Scheduled expiry')).toBeNull();
});
