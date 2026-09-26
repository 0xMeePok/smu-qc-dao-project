import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ connected: false, anchor: vi.fn(), find: vi.fn(), verify: vi.fn() }));
const account = `0x${"a".repeat(40)}`;
vi.mock("wagmi", () => ({ useAccount: () => ({ isConnected: mocks.connected, address: `0x${"a".repeat(40)}` }) }));
vi.mock("../../src/components/RelatedAuditReceiptPane.jsx", () => ({
  RELATED_AUDIT_KIND: { PROPOSAL: "proposal", LISTING: "listing", COMMENT: "comment" },
  RelatedAuditReceiptPane: () => null,
}));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: { id: `0x${"a".repeat(40)}` } }) }));
vi.mock("../../src/lib/proposals.js", () => ({ findProposal: (...args) => mocks.find(...args), withdrawProposal: vi.fn(), listProposalRevisions: async () => [] }));
vi.mock("../../src/lib/ownerReviews.js", () => ({
  listOwnerReviews: async () => ({ items: [] }),
  recordOwnerReview: vi.fn(),
  OWNER_REVIEW_OUTCOMES: [["feedback", "Record feedback"]],
  ownerReviewLabel: (value) => value,
  ownerReviewTrackerLabel: () => "",
  ownerReviewError: (error) => error?.message || "Could not record the review.",
}));
vi.mock("../../src/lib/proposalAudit.js", () => ({
  anchorProposalAudit: (...args) => mocks.anchor(...args), proposalAuditReceipt: (record) => record.audit,
  readProposalAudit: (...args) => mocks.verify(...args),
}));
vi.mock("../../src/components/ConnectWalletModal.jsx", () => ({ ConnectWalletModal: () => <p>Wallet picker</p> }));
import ProposalDetailPage from "../../src/pages/ProposalDetailPage.jsx";
const record = { id: "proposal1", researcherId: account, title: "Saved routing study", summary: "Baseline and validation", amount: 1200.25,
  currency: "USDC", category: "quantum-annealing", status: "submitted", createdAt: new Date(),
  audit: { schemaVersion: 1, entityId: `0x${"1".repeat(64)}`, contentHash: `0x${"2".repeat(64)}`, attemptCount: 0, status: "queued", transactionHash: "" } };
beforeEach(() => { mocks.connected = false; mocks.anchor.mockReset(); mocks.find.mockReset().mockResolvedValue(record);
  mocks.verify.mockReset().mockRejectedValue(new Error("execution reverted: InvalidInput")); });
afterEach(() => { vi.useRealTimers(); cleanup(); });
it("shows a concise rejection banner and clears it on retry without losing the proposal", async () => {
  mocks.connected = true;
  mocks.anchor.mockRejectedValueOnce(new Error(`User rejected the request. Request Arguments: data: 0x${"a".repeat(2000)} Details: MetaMask Tx Signature: User denied transaction signature.`))
    .mockResolvedValueOnce(undefined);
  render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} autoAnchor />);
  fireEvent.click(await screen.findByRole("button", { name: "Start verification" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Your proposal is saved. The wallet transaction was declined. You can retry when ready.");
  expect(screen.queryByText(/Request Arguments|MetaMask Tx Signature/)).toBeNull();
  expect(screen.getByRole("heading", { name: record.title })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Start verification" }));
  await waitFor(() => expect(mocks.anchor).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alert")).toBeNull();
});
it("keeps retry-limit guidance actionable without exposing the underlying error", async () => {
  mocks.connected = true;
  mocks.anchor.mockRejectedValue(new Error("The wallet retry limit has been reached. Internal details: should not be rendered."));
  render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} autoAnchor />);
  fireEvent.click(await screen.findByRole("button", { name: "Start verification" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Your proposal is saved. The wallet retry limit has been reached. Ask an administrator to reset verification attempts.");
  expect(screen.queryByText(/Internal details/)).toBeNull();
});
it("keeps a successfully saved proposal visible when its wallet is disconnected", async () => {
  render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} autoAnchor />);
  expect(await screen.findByRole("heading", { name: record.title })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Start verification" }));
  expect(await screen.findByText(/Connect the wallet that submitted it/)).toBeTruthy();
  expect(mocks.anchor).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Withdraw proposal" })).toBeTruthy();
});
it("resumes a known transaction without a connected wallet and prevents duplicate starts", async () => {
  mocks.find.mockResolvedValue({ ...record, audit: { ...record.audit, status: "pending", transactionHash: `0x${"3".repeat(64)}`, attemptCount: 3 } });
  mocks.anchor.mockImplementation(() => new Promise(() => {}));
  render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
  const button = await screen.findByRole("button", { name: "Resume verification" });
  fireEvent.click(button); fireEvent.click(button);
  expect(mocks.anchor).toHaveBeenCalledOnce();
  expect(screen.getByText(/You can continue using the app/)).toBeTruthy();
});
it("does not put a previous proposal's receipt onto a newly navigated proposal", async () => {
  mocks.connected = true;
  mocks.anchor.mockImplementation(() => new Promise(() => {}));
  const { rerender } = render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Start verification" }));
  const callback = mocks.anchor.mock.calls[0][1].onChange;
  const next = { ...record, id: "proposal2", title: "Second study", audit: { ...record.audit, contentHash: `0x${"4".repeat(64)}` } };
  mocks.find.mockResolvedValue(next);
  rerender(<ProposalDetailPage proposalId="proposal2" onNavigate={vi.fn()} />);
  await screen.findByRole("heading", { name: "Second study" });
  expect(await screen.findByRole("button", { name: "Start verification" })).toBeTruthy();
  callback({ ...record.audit, status: "failed" });
  await waitFor(() => expect(screen.getByText(next.audit.contentHash)).toBeTruthy());
  expect(screen.queryByText("Proposal saved; verification needs attention")).toBeNull();
});

it("shows Open for funding instead of the raw submitted status", async () => {
  render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
  expect(await screen.findByText("Open for funding")).toBeTruthy();
  expect(screen.queryByText("submitted")).toBeNull();
});

it("keeps Open for funding when a later snapshot omits matching.status", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mocks.find.mockResolvedValue({ ...record, matching: { status: "funding", evaluationComplete: true } });
  render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
  expect(await screen.findByText("Open for funding")).toBeTruthy();
  mocks.find.mockResolvedValue({ ...record, matching: { evaluationComplete: true } });
  await vi.advanceTimersByTimeAsync(10_000);
  await waitFor(() => expect(mocks.find).toHaveBeenCalledWith("proposal1", { fromServer: true }));
  expect(screen.getByText("Open for funding")).toBeTruthy();
  expect(screen.queryByText("submitted")).toBeNull();
  vi.useRealTimers();
});

it("reads the chain for a missing receipt and never auto-signs already verified content", async () => {
  mocks.verify.mockResolvedValue({ verified: true });
  render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} autoAnchor />);
  expect(await screen.findByText("Verified on Arbitrum Sepolia")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /start verification|resume verification/i })).toBeNull();
  expect(screen.queryByText("Wallet picker")).toBeNull();
  expect(mocks.anchor).not.toHaveBeenCalled();
});
it("groups the proposal into tabs instead of one long page", async () => {
  mocks.find.mockResolvedValue({ ...record, methodology: "Hybrid annealing", suitability: "Fits the constraints", timeline: "Six months", team: "Two researchers" });
  render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} justSubmitted />);
  const overview = await screen.findByRole("tab", { name: "Overview" });
  expect(overview.getAttribute("aria-selected")).toBe("true");
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Overview", "Match & funding", "Record"]);
  const approach = screen.getByRole("heading", { name: "The approach" }).closest("section");
  expect(approach.textContent).toContain("Hybrid annealing");
  expect(approach.textContent).toContain("Fits the constraints");
  expect(screen.getByRole("heading", { name: "Delivery" }).closest("section").textContent).toContain("Two researchers");
  expect(screen.queryByRole("heading", { name: "What success looks like" })).toBeNull();
  expect(document.getElementById("proposal-panel-record").className).not.toContain("is-active");
  fireEvent.click(screen.getByRole("button", { name: "Check its on-chain verification" }));
  expect(screen.getByRole("tab", { name: "Record" }).getAttribute("aria-selected")).toBe("true");
  expect(document.getElementById("proposal-panel-record").className).toContain("is-active");
  expect(document.getElementById("proposal-panel-overview").className).not.toContain("is-active");
});
it("gives only the sponsor a Feedback tab, where the review form always is", async () => {
  mocks.find.mockResolvedValue({ ...record, researcherId: `0x${"b".repeat(40)}`, postingOwnerId: account });
  render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
  await screen.findByRole("tab", { name: "Overview" });
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Overview", "Match & funding", "Feedback", "Record"]);
});
