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

const candidate = (overrides = {}) => ({ id: "proposal-1", title: "Quantum routing", currency: "USD", amount: 100, fundedAmount: 100, matching: { status: "funding" }, canFund: false, canSelect: true, canConfirm: false, canDecline: false, canApproveOwner: false, ...overrides });
const snapshot = (overrides = {}) => ({ matching: { status: "funding" }, proposals: [candidate()], contributions: [], ...overrides });
const waiting = (overrides = {}) => snapshot({ matching: { status: "awaiting_confirmation", proposalId: "proposal-1", ownerApprovedBy: "owner", ownerApprovedAt: "2099-09-15T00:00:00Z", selectedBy: "owner", selectedAt: "2099-09-15T00:00:00Z", deadlineAt: "2099-09-22T00:00:00Z" }, ...overrides });
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

  it("keeps selection out of the funding panel and describes both gates", async () => {
    mocks.read.mockResolvedValue(snapshot({ proposals: [candidate({ matching: { status: "funding", evaluationComplete: false }, canSelect: true })] }));
    render(<MatchingPanel problemId="problem-1" proposalId="proposal-1" />);
    await screen.findByRole("heading", { name: "Quantum routing" });
    expect(screen.queryByRole("button", { name: "Select proposal" })).toBeNull();
    expect(screen.getByText("Fully funded · awaiting owner selection")).toBeTruthy();
    expect(screen.getByText(/selects from the comparison once this proposal is fully funded and has a qualifying evaluator recommendation/)).toBeTruthy();
    expect(screen.queryByText(/Fund individual proposals for this problem/)).toBeNull();
    expect(screen.queryByText(/selects one after it is fully funded and has a qualifying evaluator recommendation/)).toBeNull();
  });

  it("links each comparison candidate to the proposal being funded", async () => {
    const navigate = vi.fn();
    render(<MatchingPanel problemId="problem-1" onNavigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "View proposal" }));
    expect(navigate).toHaveBeenCalledWith("proposal/proposal-1");
  });

  it("only exposes the capabilities granted by the server for this viewer", async () => {
    mocks.read.mockResolvedValue(snapshot({ proposals: [candidate({ canSelect: false })] }));
    render(<MatchingPanel problemId="problem-1" />);
    await screen.findByRole("heading", { name: "Quantum routing" });
    expect(screen.queryByRole("button", { name: "Select proposal" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Accept as proposal creator/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fund proposal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Complete mock evaluation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expire window for demonstration" })).toBeNull();
  });

  it("requires a creator's decline reason and shows the refund result", async () => {
    mocks.user = { id: "creator" };
    mocks.read.mockResolvedValueOnce(waiting({ proposals: [candidate({ canSelect: false, canConfirm: true, canDecline: true })] }))
      .mockResolvedValue(snapshot({ proposals: [candidate({ canSelect: false, matching: { status: "voided" } })] }));
    render(<MatchingPanel problemId="problem-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject selection" }));
    expect(screen.getByRole("dialog", { name: "Reject this selection?" })).toBeTruthy();
    submit();
    expect(screen.getByRole("alert").textContent).toContain("at least 10 characters");
    expect(mocks.decline).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Reason for rejecting"), { target: { value: "  Team capacity is no longer available.  " } });
    submit();
    await screen.findByText(/Selection rejected. The selected proposal’s funders are refunded/);
    expect(mocks.decline).toHaveBeenCalledWith({ problemId: "problem-1", proposalId: "proposal-1", reason: "Team capacity is no longer available." });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lets an authorized administrator record an optional mock evaluation explicitly", async () => {
    mocks.user = { id: "admin" };
    mocks.read.mockResolvedValueOnce(snapshot({ proposals: [candidate({ canSelect: false, canCompleteEvaluation: true })] }))
      .mockResolvedValue(snapshot({ proposals: [candidate({ canSelect: false, matching: { status: "funding", evaluationComplete: true } })] }));
    render(<MatchingPanel problemId="problem-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete mock evaluation" }));
    expect(screen.getByRole("dialog", { name: "Complete mock expert evaluation?" })).toBeTruthy();
    expect(screen.getByText(/This is a simulated evaluation/)).toBeTruthy();
    expect(mocks.evaluate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Record mock evaluation" }));
    await screen.findByText(/Optional mock evaluation recorded/);
    expect(mocks.evaluate).toHaveBeenCalledWith({ problemId: "problem-1", proposalId: "proposal-1" });
    expect(screen.getByText(/Optional expert evaluation: Complete/)).toBeTruthy();
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
    expect(screen.getByText("Problem owner acceptance")).toBeTruthy();
    expect(screen.getByText("Awaiting proposal creator acceptance")).toBeTruthy();
    const record = document.getElementById("matching-event-decision-123");
    expect(within(record).getByText("owner-123")).toBeTruthy();
    expect(within(record).getByText("The strongest technical fit.")).toBeTruthy();
    expect(within(record).getByText("decision-123")).toBeTruthy();
    expect(screen.getByText("Showing the latest 100 events.")).toBeTruthy();
  });

  it("pauses all sibling funding and selection during the seven-day window", async () => {
    mocks.read.mockResolvedValue(waiting({ proposals: [candidate({ canSelect: true, canFund: true }), candidate({ id: "proposal-2", title: "Another approach", fundedAmount: 20, canFund: true })] }));
    render(<MatchingPanel problemId="problem-1" />);
    await screen.findByText("Seven-day acceptance window");
    expect(screen.getByText(/Funding is paused for every proposal/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fund proposal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Select proposal" })).toBeNull();
  });

  it("lets the selected creator confirm locking and sibling refunds explicitly", async () => {
    mocks.user = { id: "creator" };
    mocks.read.mockResolvedValueOnce(waiting({ proposals: [candidate({ canSelect: false, canConfirm: true, canDecline: true })] }))
      .mockResolvedValue(snapshot({ matching: { status: "confirmed" }, proposals: [candidate({ canSelect: false, matching: { status: "confirmed" } })] }));
    render(<MatchingPanel problemId="problem-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept as proposal creator" }));
    const dialog = screen.getByRole("dialog", { name: "Accept this selection?" });
    expect(within(dialog).getByText(/All other proposals on this problem will be cancelled/)).toBeTruthy();
    expect(mocks.confirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Record my acceptance" }));
    await screen.findByText(/Both parties approved/);
    expect(mocks.confirm).toHaveBeenCalledWith({ problemId: "problem-1", proposalId: "proposal-1" });
    expect(screen.queryByRole("button", { name: /Accept as proposal creator/ })).toBeNull();
  });

  it("shows owner acceptance from selection without asking the owner to accept again", async () => {
    mocks.read.mockResolvedValue(waiting({ proposals: [candidate({ canSelect: false, canDecline: true })],
      history: [{ id: "selection", type: "owner_selected", proposalId: "proposal-1", actorId: "owner", createdAt: "2099-09-15T00:00:00Z" }] }));
    render(<MatchingPanel problemId="problem-1" />);
    await screen.findByText("The problem owner accepted by selecting this proposal. The creator still needs to accept.");
    expect(screen.getByText("Accepted 2099-09-15 00:00:00 UTC")).toBeTruthy();
    expect(screen.getByText("2099-09-22 00:00:00 UTC")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept as problem owner" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reject selection" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View owner acceptance record" }));
    expect(document.getElementById("matching-event-selection").open).toBe(true);
  });

  it.each(["owner", "creator"])("lets the %s reject, shows the selected refund and restores sibling funding", async (actor) => {
    mocks.user = { id: actor };
    mocks.read.mockResolvedValueOnce(waiting({ proposals: [candidate({ canSelect: false, canDecline: true })] }))
      .mockResolvedValue(snapshot({ matching: { status: "open" }, proposals: [candidate({ canSelect: false, matching: { status: "declined" } }), candidate({ id: "proposal-2", title: "Alternative", amount: 100, fundedAmount: 40, canSelect: false, canFund: true })] }));
    render(<MatchingPanel problemId="problem-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject selection" }));
    expect(screen.getByText(/all its contributions refunded/)).toBeTruthy();
    expect(screen.getByText(/keeping their existing contributions/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reason for rejecting"), { target: { value: "This match no longer meets our needs." } });
    fireEvent.click(screen.getByRole("button", { name: "Reject and refund funders" }));
    await screen.findByText("Rejected · funders refunded");
    expect(mocks.decline).toHaveBeenCalledWith({ problemId: "problem-1", proposalId: "proposal-1", reason: "This match no longer meets our needs." });
    expect(screen.queryByText("Seven-day acceptance window")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Fund proposal" })).toHaveLength(1);
    expect(screen.getByText("USD 40")).toBeTruthy();
  });

  it("labels sibling funding as paused while awaiting creator acceptance", async () => {
    mocks.read.mockResolvedValue(waiting({ proposals: [candidate({ canSelect: false, canDecline: true, matching: { status: "awaiting_confirmation" } }), candidate({ id: "proposal-2", title: "Alternative", amount: 100, fundedAmount: 40, canSelect: false, canFund: true })] }));
    render(<MatchingPanel problemId="problem-1" />);
    await screen.findByText("The problem owner accepted by selecting this proposal. The creator still needs to accept.");
    expect(screen.queryByText("Awaiting problem owner acceptance")).toBeNull();
    expect(screen.getByText("Awaiting proposal creator acceptance")).toBeTruthy();
    expect(screen.getByText("Funding paused · another proposal selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fund proposal" })).toBeNull();
  });

  it("shows terminal invalidation and refunds after server refresh", async () => {
    mocks.read.mockResolvedValueOnce(waiting()).mockResolvedValue(snapshot({
      matching: { status: "invalidated", invalidationReason: "confirmation_expired" },
      proposals: [candidate({ canSelect: false, matching: { status: "voided" } }), candidate({ id: "proposal-2", title: "Another approach", fundedAmount: 20, canSelect: false, canFund: true })],
      contributions: [{ id: "pledge", proposalId: "proposal-1", amount: 100, currency: "USD", status: "refunded" }],
    }));
    render(<MatchingPanel problemId="problem-1" />);
    await screen.findByText("Seven-day acceptance window");
    fireEvent.click(screen.getByRole("button", { name: "Refresh funding status" }));
    await screen.findByText("Voided · funders refunded");
    expect(screen.getByText("USD 100 · Refunded to you")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fund proposal" })).toBeNull();
    expect(screen.getByText("Problem invalidated")).toBeTruthy();
    expect(screen.queryByText("Seven-day acceptance window")).toBeNull();
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

  it("does not let a delayed background poll overwrite a completed contribution", async () => {
    vi.useFakeTimers();
    let resolvePoll;
    mocks.read.mockResolvedValueOnce(snapshot({ proposals: [candidate({ fundedAmount: 20, canFund: true, canSelect: false })] }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }))
      .mockResolvedValue(snapshot({ proposals: [candidate({ fundedAmount: 45, canFund: true, canSelect: false })] }));
    await act(async () => { render(<MatchingPanel problemId="problem-1" />); });
    await act(async () => { vi.advanceTimersByTime(30_000); });
    fireEvent.click(screen.getByRole("button", { name: "Fund proposal" }));
    await act(async () => { submit(); });
    expect(screen.getByText("Mock contribution recorded.")).toBeTruthy();
    expect(screen.getByText(/USD 45/)).toBeTruthy();
    await act(async () => { resolvePoll(snapshot({ proposals: [candidate({ fundedAmount: 20, canFund: true, canSelect: false })] })); });
    expect(screen.getByText("Mock contribution recorded.")).toBeTruthy();
    expect(screen.getByText(/USD 45/)).toBeTruthy();
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
  it("shows pledged, locked and refunded entries with reasons and proposal navigation", async () => {
    mocks.portfolio.mockResolvedValue({ contributions: ["pledged", "locked", "refunded"].map((status) => ({ id: status, title: `${status} proposal`, status, currency: "USD", amount: 25, problemId: "problem-1", proposalId: `proposal-${status}`, createdAt: "2026-09-15T00:00:00Z", ...(status === "refunded" ? { refundReason: "confirmation_expired", settledAt: "2026-09-22T00:00:00Z" } : {}) })) });
    const navigate = vi.fn();
    render(<MockFundingPortfolio onNavigate={navigate} />);
    await screen.findByText("refunded proposal");
    expect(screen.getByText(/USD 25 · Pledged/)).toBeTruthy();
    expect(screen.getByText(/USD 25 · Locked/)).toBeTruthy();
    expect(screen.getByText(/USD 25 · Refunded/)).toBeTruthy();
    expect(screen.getByText("Returned to you as mock funds · confirmation expired")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "View proposal" })[0]);
    expect(navigate).toHaveBeenCalledWith("proposal/proposal-pledged");
  });

  it("allows retry after a portfolio read error and then shows browse navigation", async () => {
    mocks.portfolio.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ contributions: [] });
    const navigate = vi.fn();
    render(<MockFundingPortfolio onNavigate={navigate} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(await screen.findByRole("button", { name: "Find proposals to fund" }));
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

it('shows a shorter posting-limited window and an off-chain receipt with the same countdown', async () => {
  mocks.read.mockResolvedValue(waiting({ matching: { ...waiting().matching, deadlineAt: '2099-09-17T00:00:00Z', postingExpiresAt: '2099-09-17T00:00:00Z', deadlineLimitedByPosting: true }, history: [{ id: 'limited', type: 'owner_selected', actorId: 'owner', actorRole: 'problem_owner', actorWallet: '0x123', proposalId: 'proposal-1', deadlineAt: '2099-09-17T00:00:00Z', createdAt: '2099-09-15T00:00:00Z' }] }));
  render(<MatchingPanel problemId="problem-1" />);
  await screen.findByText('Acceptance window ends at posting expiry');
  expect(screen.getByText(/remaining posting window is shorter than seven days/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'View selection record' }));
  const receipt = document.getElementById('matching-event-limited');
  expect(receipt.open).toBe(true);
  expect(within(receipt).getByText('Recorded off-chain')).toBeTruthy();
  expect(within(receipt).getByText('problem_owner')).toBeTruthy();
  expect(within(receipt).getByText('0x123')).toBeTruthy();
  expect(within(receipt).getByText('Time remaining')).toBeTruthy();
  expect(screen.queryByText(/On-chain recording will be connected/)).toBeNull();
});

it('retains explicit reopening state and links both rejection and reopening receipts after reload', async () => {
  mocks.read.mockResolvedValue(snapshot({ matching: { status: 'open', reopenedAt: '2099-09-16T00:00:00Z', postingExpiresAt: '2099-09-20T00:00:00Z' }, proposals: [candidate({ canSelect: false, matching: { status: 'declined' } })], history: ['owner_declined', 'posting_reopened'].map(type => ({ id: type, type, proposalId: 'proposal-1', createdAt: '2099-09-16T00:00:00Z' })) }));
  render(<MatchingPanel problemId="problem-1" />);
  await screen.findByText('Selection rejected · problem reopened');
  for (const [label, id] of [['View rejection record', 'owner_declined'], ['View reopening record', 'posting_reopened']]) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }));
    expect(document.getElementById(`matching-event-${id}`).open).toBe(true);
  }
  expect(screen.queryByText(/You can select this proposal now/)).toBeNull();
  expect(screen.getByText(/Funding shown is historical/)).toBeTruthy();
});

it('shows an invalidation receipt and blocks stale funding or selection capabilities', async () => {
  mocks.read.mockResolvedValue(snapshot({ matching: { status: 'invalidated', invalidationReason: 'posting_expired' }, proposals: [candidate({ canSelect: true, canFund: true })], history: [{ id: 'closed', type: 'posting_invalidated', proposalId: null, createdAt: '2099-09-20T00:00:00Z' }] }));
  render(<MatchingPanel problemId="problem-1" />);
  await screen.findByText('Problem invalidated');
  expect(screen.getByText(/original posting deadline passed/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Select proposal' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Fund proposal' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /View invalidation record/ }));
  expect(document.getElementById('matching-event-closed').open).toBe(true);
});
