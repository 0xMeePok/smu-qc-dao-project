import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const author = `0x${"a".repeat(40)}`;
const owner = `0x${"b".repeat(40)}`;
const evaluator = `0x${"c".repeat(40)}`;
const mocks = vi.hoisted(() => ({
  userId: `0x${"a".repeat(40)}`,
  roles: [],
  list: vi.fn(),
  record: vi.fn(),
  find: vi.fn(),
}));
vi.mock("wagmi", () => ({ useAccount: () => ({ isConnected: false, address: `0x${"a".repeat(40)}` }) }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: { id: mocks.userId, roles: mocks.roles } }) }));
vi.mock("../../src/lib/ownerReviews.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, listOwnerReviews: (...args) => mocks.list(...args), recordOwnerReview: (...args) => mocks.record(...args) };
});
vi.mock("../../src/lib/proposals.js", () => ({ findProposal: (...args) => mocks.find(...args), withdrawProposal: vi.fn(), listProposalRevisions: async () => [] }));
vi.mock("../../src/lib/proposalAudit.js", () => ({
  anchorProposalAudit: vi.fn(), proposalAuditReceipt: (record) => record.audit, readProposalAudit: vi.fn(),
}));
vi.mock("../../src/lib/matching.js", async (importOriginal) => ({
  ...await importOriginal(),
  getMockMatching: async () => ({ matching: { status: "open" }, proposals: [], contributions: [] }),
}));
vi.mock("../../src/lib/moderation.js", () => ({
  isModerated: () => false,
  listReportableComments: async () => ({ items: [] }),
  moderationError: (error) => error.message,
}));
vi.mock("../../src/components/ConnectWalletModal.jsx", () => ({ ConnectWalletModal: () => null }));
vi.mock("../../src/components/RelatedAuditReceiptPane.jsx", () => ({
  RELATED_AUDIT_KIND: { PROPOSAL: "proposal", LISTING: "listing", COMMENT: "comment" },
  RelatedAuditReceiptPane: () => null,
}));

import { OwnerReviewPanel } from "../../src/components/OwnerReviewPanel.jsx";
import ProposalDetailPage from "../../src/pages/ProposalDetailPage.jsx";

const review = {
  id: "rev1", actorId: owner, actorRole: "problem_owner", outcome: "revision_requested",
  rationale: "Please tighten the benchmark section before this proceeds.",
  createdAt: "2026-09-24T00:00:00.000Z", correctionPathOpen: true,
};
const proposal = {
  id: "proposal1", researcherId: author, postingOwnerId: owner, problemId: "problem1",
  title: "Saved routing study", summary: "Baseline and validation", amount: 1200, currency: "USDC",
  category: "quantum-annealing", status: "submitted", createdAt: new Date(), problemMatching: { status: "open" },
  audit: { status: "confirmed" },
};

beforeEach(() => {
  mocks.userId = author;
  mocks.roles = [];
  mocks.list.mockReset().mockResolvedValue({ items: [review] });
  mocks.record.mockReset().mockResolvedValue({ ...review, id: "rev2", outcome: "feedback" });
  mocks.find.mockReset().mockResolvedValue(proposal);
});
afterEach(cleanup);

it("shows the owner rationale to the author and keeps the review form off their page", async () => {
  render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
  expect(await screen.findByText(review.rationale)).toBeTruthy();
  expect(screen.getByText(/Edit the proposal and resubmit/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Record review" })).toBeNull();
});

it("hides the owner review form and trail from an evaluator", async () => {
  mocks.userId = evaluator;
  mocks.roles = ["evaluator"];
  render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
  expect(await screen.findByRole("heading", { name: proposal.title })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Owner review" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Record review" })).toBeNull();
});

it("requires a written rationale before the owner records an outcome", async () => {
  mocks.list.mockResolvedValue({ items: [] });
  render(<OwnerReviewPanel proposalId="proposal1" canRecord revisionPathOpen />);
  expect(await screen.findByRole("button", { name: "Record review" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Rationale"), { target: { value: "too short" } });
  fireEvent.click(screen.getByRole("button", { name: "Record review" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(mocks.record).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Rationale"), { target: { value: review.rationale } });
  fireEvent.click(screen.getByRole("button", { name: "Record review" }));
  await screen.findByText("Record feedback");
  expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ proposalId: "proposal1", outcome: "feedback", rationale: review.rationale }));
});
