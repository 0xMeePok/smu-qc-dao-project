import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), user: { id: "researcher" } }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../src/lib/proposalQueues.js", async importOriginal => ({ ...await importOriginal(), listMyProposalQueue: (...args) => mocks.fetch(...args) }));
import { ProposalTracker } from "../../src/components/ProposalTracker.jsx";
const acceptance = "2099-10-09T00:00:00.000Z";
const row = (id, grant) => ({ id, title: `Grant ${id}`, problemId: "grant-call", status: "submitted", workflowStatus: "expired",
  createdAt: "2026-10-01T00:00:00.000Z", recommendations: [], posting: { title: "Grant call", status: "expired", expiresAt: "2020-01-01T00:00:00.000Z" }, grant });
beforeEach(() => { mocks.user = { id: "researcher" }; mocks.fetch.mockReset().mockResolvedValue({ items: [] }); });
afterEach(cleanup);

it("uses the verified grant deadline and acceptance action after the posting has closed", async () => {
  const go = vi.fn(); mocks.fetch.mockResolvedValue({ items: [row("pending", { status: "pending", canAccept: true,
    acceptanceDeadline: String(Date.parse(acceptance) / 1000) })] });
  render(<ProposalTracker onNavigate={go} />);
  const item = (await screen.findByText("Grant pending")).closest(".table-row");
  expect(within(item).getByText("Selected")).toBeTruthy();
  expect(within(item).queryByText("Expired")).toBeNull();
  expect(item.querySelector(".expiry-countdown").getAttribute("aria-label")).toContain("2099-10-09");
  fireEvent.click(within(item).getByRole("button", { name: "Accept grant" }));
  expect(go).toHaveBeenCalledWith("proposal/pending?tab=funding");
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "selected" } });
  expect(screen.getByText("Grant pending")).toBeTruthy();
});

it("keeps accepted grants out of expired posting countdowns and labels expired offers without acceptance", async () => {
  mocks.fetch.mockResolvedValue({ items: [row("accepted", { status: "accepted", canAccept: false }),
    row("expired", { status: "expired", canAccept: false, deadlineAt: "2020-01-08T00:00:00.000Z" })] });
  render(<ProposalTracker onNavigate={() => {}} />);
  const accepted = (await screen.findByText("Grant accepted")).closest(".table-row");
  expect(within(accepted).getByText("Accepted")).toBeTruthy();
  expect(accepted.querySelector(".expiry-countdown")).toBeNull();
  expect(within(accepted).getByRole("button", { name: "View escrow" })).toBeTruthy();
  const expired = screen.getByText("Grant expired").closest(".table-row");
  expect(expired.querySelector(".workflow-badge").textContent).toBe("Expired");
  expect(within(expired).queryByRole("button", { name: "Accept grant" })).toBeNull();
});

it("shows unavailable offer verification without trusting a cached status or deadline", async () => {
  mocks.fetch.mockResolvedValue({ items: [{ ...row("unknown"), grantUnavailable: true }], unavailableGrantOffers: 1 });
  render(<ProposalTracker onNavigate={() => {}} />);
  expect(await screen.findByText(/1 grant offer records could not be verified/)).toBeTruthy();
  const item = screen.getByText("Grant unknown").closest(".table-row");
  expect(within(item).getByText("Grant offer status is temporarily unavailable.")).toBeTruthy();
  expect(item.querySelector(".expiry-countdown")).toBeNull();
  expect(within(item).queryByRole("button", { name: "Accept grant" })).toBeNull();
  expect(item.querySelector(".workflow-badge")?.textContent).not.toBe("Expired");
});

it("clears the previous wallet's proposals and ignores its delayed response after an account change", async () => {
  mocks.fetch.mockResolvedValueOnce({ items: [row("old-wallet", { status: "accepted" })] });
  const view = render(<ProposalTracker onNavigate={() => {}} />);
  await screen.findByText("Grant old-wallet");
  let resolveOld, resolveNew;
  mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh proposals" }));
  mocks.user = { id: "another-researcher" };
  mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
  view.rerender(<ProposalTracker onNavigate={() => {}} />);
  expect(screen.queryByText("Grant old-wallet")).toBeNull();
  await act(async () => resolveNew({ items: [row("new-wallet", { status: "pending", canAccept: true, deadlineAt: acceptance })] }));
  await screen.findByText("Grant new-wallet");
  await act(async () => resolveOld({ items: [row("old-wallet", { status: "accepted" })] }));
  expect(screen.queryByText("Grant old-wallet")).toBeNull();
  expect(screen.getByText("Grant new-wallet")).toBeTruthy();
});

it.each([["Locked", "pending_approval", "Pending approval"], ["Active", "accepted", "Accepted"],
  ["Cancelled", "cancelled", "Cancelled"], ["Refunded", "refunded", "Refunded"],
  ["Expired", "expired", "Expired"], ["Voided", "invalidated", "Invalidated"],
  ["Released", "completed", "Completed"]])("shows the canonical %s escrow lifecycle instead of a stored Submitted badge", async (state, workflowStatus, label) => {
  const go = vi.fn();
  const deadlineAt = ["Locked", "Active"].includes(state) ? acceptance : null;
  mocks.fetch.mockResolvedValue({ items: [{ ...row("main"), title: "Main solution", workflowStatus: "submitted",
    escrow: { state, workflowStatus, deadlineAt } }] });
  render(<ProposalTracker onNavigate={go} />);
  const item = (await screen.findByText("Main solution")).closest(".table-row");
  expect(item.querySelector(".workflow-badge").textContent).toBe(label);
  if (deadlineAt) expect(item.querySelector(".expiry-countdown").getAttribute("aria-label")).toContain("2099-10-09");
  else expect(item.querySelector(".expiry-countdown")).toBeNull();
  fireEvent.click(within(item).getByRole("button", { name: "View escrow" }));
  expect(go).toHaveBeenCalledWith("proposal/main?tab=funding");
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: workflowStatus } });
  expect(screen.getByText("Main solution")).toBeTruthy();
});

it("shows completed grant payments after the persistent accepted offer and uses the final delivery deadline while active", async () => {
  mocks.fetch.mockResolvedValue({ items: [
    { ...row("completed", { status: "accepted" }), escrow: { state: "Released", workflowStatus: "completed", deadlineAt: null } },
    { ...row("delivery", { status: "accepted" }), escrow: { state: "Active", workflowStatus: "accepted", deadlineAt: acceptance } },
  ] });
  render(<ProposalTracker onNavigate={() => {}} />);
  const completed = (await screen.findByText("Grant completed")).closest(".table-row");
  expect(completed.querySelector(".workflow-badge").textContent).toBe("Completed");
  expect(completed.querySelector(".expiry-countdown")).toBeNull();
  const active = screen.getByText("Grant delivery").closest(".table-row");
  expect(active.querySelector(".expiry-countdown").getAttribute("aria-label")).toContain("2099-10-09");
  expect(within(active).getByText("Escrow approval:")).toBeTruthy();
});

it("keeps an unavailable main escrow out of stored-status filters and posting expiry countdowns", async () => {
  mocks.fetch.mockResolvedValue({ items: [{ ...row("unknown-main"), grantUnavailable: false, escrowUnavailable: true }], unavailableEscrows: 1 });
  render(<ProposalTracker onNavigate={() => {}} />);
  expect(await screen.findByText(/1 escrow records could not be verified/)).toBeTruthy();
  const item = screen.getByText("Grant unknown-main").closest(".table-row");
  expect(within(item).queryByText("Expired")).toBeNull();
  expect(within(item).queryByText("Submitted")).toBeNull();
  expect(item.querySelector(".expiry-countdown")).toBeNull();
  expect(within(item).getByText("Escrow status is temporarily unavailable.")).toBeTruthy();
  expect(within(item).getByRole("button", { name: "View escrow" })).toBeTruthy();
  expect(screen.getByLabelText("Status").options).toHaveLength(1);
});

it("replaces the countdown with a dash when the proposal was removed", async () => {
  mocks.fetch.mockResolvedValue({ items: [{
    id: "removed", title: "Removed listing", proposalKind: "independent", status: "moderated_removed",
    moderationStatus: "removed", createdAt: "2026-10-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    recommendations: [],
  }] });
  render(<ProposalTracker onNavigate={() => {}} />);
  const item = (await screen.findByText("Removed listing")).closest(".table-row");
  expect(within(item).getByLabelText("No time remaining").textContent).toBe("—");
  expect(item.querySelector(".expiry-countdown")).toBeNull();
});

it("retains unavailable escrow verification warnings when no proposals could be loaded", async () => {
  mocks.fetch.mockResolvedValue({ items: [], unavailableEscrows: 1 });
  render(<ProposalTracker onNavigate={() => {}} />);
  expect(await screen.findByText(/1 escrow records could not be verified/)).toBeTruthy();
  expect(screen.getByText("Verified proposal records are temporarily unavailable. Refresh to retry.")).toBeTruthy();
  expect(screen.queryByText(/No proposals yet/)).toBeNull();
});
