import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const account = `0x${"a".repeat(40)}`;
const mocks = vi.hoisted(() => ({
  matching: vi.fn(),
  posting: null,
  update: vi.fn(),
  updateFunding: vi.fn(),
  audit: vi.fn(),
  fundingAudit: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../../src/lib/matching.js", async (importOriginal) => ({
  ...await importOriginal(),
  getMockMatching: (...args) => mocks.matching(...args),
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ isConnected: true, address: account }),
}));
vi.mock("../../src/context/SessionContext.jsx", () => ({
  useSession: () => ({
    address: account,
    profile: { organisation: "Singapore Management University" },
  }),
}));
vi.mock("../../src/lib/postings.js", () => ({
  newPostingId: () => "posting1",
  findPosting: async () => mocks.posting,
  buildPostingDocument: ({ form, attachments, status, expiresAt }) => ({
    ownerId: account,
    organisation: "Singapore Management University",
    ...form,
    amount: Number(form.amount),
    attachments,
    status: status ?? "submitted",
    expiresAt: expiresAt ?? mocks.posting?.expiresAt ?? new Date("2099-12-01T00:00:00Z"),
    createdAt: mocks.posting?.createdAt,
    updatedAt: new Date(),
  }),
  updatePosting: (...args) => mocks.update(...args),
  createPosting: vi.fn(),
  publishDraft: vi.fn(),
  saveDraft: vi.fn(),
}));
vi.mock("../../src/lib/postingAudit.js", () => ({
  postingAuditReceipt: (posting) => posting.audit ?? null,
  readPostingAudit: async () => ({ verified: true }),
  receiptForWrite: (audit) => audit && audit.status === "confirmed" ? { ...audit, status: "pending" } : audit,
  anchorPostingAudit: (...args) => mocks.audit(...args),
}));
vi.mock("../../src/lib/attachments.js", () => ({
  deleteAttachment: async () => {},
}));
vi.mock("../../src/components/AttachmentUploader.jsx", () => ({
  AttachmentUploader: () => <div>Uploader</div>,
}));
vi.mock("../../src/components/ConnectWalletModal.jsx", () => ({
  ConnectWalletModal: () => null,
}));
vi.mock("../../src/lib/fundingOpportunities.js", () => ({
  newFundingOpportunityId: () => "funding1",
  FUNDING_STATUS_DRAFT: "draft",
  buildFundingOpportunityDocument: ({ form, attachments, status, expiresAt }) => ({
    opportunityType: "open-funding",
    ownerId: account,
    organisation: "Singapore Management University",
    ...form,
    amount: Number(form.amount),
    attachments,
    status: status ?? "submitted",
    expiresAt: expiresAt ?? mocks.posting?.expiresAt ?? new Date("2099-12-01T00:00:00Z"),
    createdAt: mocks.posting?.createdAt,
    updatedAt: new Date(),
  }),
  updateFundingOpportunity: (...args) => mocks.updateFunding(...args),
  createFundingOpportunity: vi.fn(),
  publishFundingDraft: vi.fn(),
  saveFundingDraft: vi.fn(),
}));
vi.mock("../../src/lib/fundingOpportunityAudit.js", () => ({
  fundingOpportunityAuditReceipt: (opportunity) => opportunity.audit ?? null,
  readFundingOpportunityAudit: async () => ({ verified: true }),
  receiptForWrite: (audit) => audit && audit.status === "confirmed" ? { ...audit, status: "pending" } : audit,
  anchorFundingOpportunityAudit: (...args) => mocks.fundingAudit(...args),
}));

import CreatePostingPage from "../../src/pages/CreatePostingPage.jsx";
import CreateFundingOpportunityPage from "../../src/pages/CreateFundingOpportunityPage.jsx";

const live = {
  id: "posting1",
  ownerId: account,
  organisation: "Singapore Management University",
  title: "Cold-chain route optimisation",
  summary: "Routing degrades under demand spikes.",
  businessContext: "Logistics",
  currentApproach: "Heuristic",
  currentLimitations: "Runtime",
  expectedOutcome: "Faster routes",
  successCriteria: "Ten percent",
  dataAvailability: "Telemetry",
  status: "submitted",
  categories: ["ai"],
  amount: 80000,
  currency: "USDT",
  attachments: [],
  proposalCount: 0,
  createdAt: new Date("2026-09-01T10:00:00Z"),
  expiresAt: new Date("2099-12-01T00:00:00Z"),
};

beforeEach(() => {
  mocks.matching.mockReset().mockResolvedValue({
    matching: { status: "funding", totalFundedMinor: 0 },
    proposals: [{ id: "proposal1", status: "submitted", fundedAmount: 0, matching: { status: "funding" } }],
    contributions: [],
  });
  mocks.posting = { ...live };
  mocks.navigate.mockReset();
  mocks.update.mockReset().mockResolvedValue({ ...live, title: "Corrected title" });
  mocks.updateFunding.mockReset().mockResolvedValue({ ...live, title: "Corrected title" });
  const receipt = {
    schemaVersion: 1, chainId: 421614, entityId: `0x${"1".repeat(64)}`,
    contentHash: `0x${"2".repeat(64)}`, status: "confirmed",
    transactionHash: `0x${"3".repeat(64)}`, blockNumber: 9, attemptCount: 1, lastError: "",
  };
  mocks.audit.mockReset().mockResolvedValue(receipt);
  mocks.fundingAudit.mockReset().mockResolvedValue(receipt);
});
afterEach(cleanup);

describe("editing a published posting", () => {
  it("does not sign an edit when funding arrives after the form loads", async () => {
    render(<CreatePostingPage editPostingId="posting1" onNavigate={mocks.navigate} />);
    await screen.findByRole("heading", { name: "Edit your problem statement" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Corrected title" } });
    mocks.matching.mockResolvedValue({ matching: { status: "funding", totalFundedMinor: 1000 }, proposals: [] });
    fireEvent.click(screen.getByRole("button", { name: "Sign and save changes" }));
    expect(await screen.findByText(/Funding or matching has started/)).toBeTruthy();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("signs updateOpportunity before saving when no proposal has arrived", async () => {
    render(<CreatePostingPage editPostingId="posting1" onNavigate={mocks.navigate} />);
    await screen.findByRole("heading", { name: "Edit your problem statement" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Corrected title" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and save changes" }));
    await waitFor(() => expect(mocks.audit).toHaveBeenCalled());
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.audit.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[0]);
    expect(await screen.findByText("Posting updated")).toBeTruthy();
  });

  it("locks the funded ask after the first proposal and still allows attachments", async () => {
    mocks.posting = { ...live, proposalCount: 1 };
    render(<CreatePostingPage editPostingId="posting1" onNavigate={mocks.navigate} />);
    await screen.findByText(/A proposal has already been received/);
    expect(screen.getByText("1. The problem").closest("fieldset").disabled).toBe(true);
    expect(screen.getByText("5. Funding and timing").closest("fieldset").disabled).toBe(true);
    expect(screen.getByText("6. Extend the response window").closest("fieldset").disabled).toBe(false);
    expect(screen.getByText("7. Supporting documents").closest("fieldset").disabled).toBe(false);
  });

  it("adds a selected extension to the stored deadline rather than re-anchoring at creation", async () => {
    render(<CreatePostingPage editPostingId="posting1" onNavigate={mocks.navigate} />);
    await screen.findByRole("heading", { name: "Edit your problem statement" });
    fireEvent.change(screen.getByLabelText("Extend by"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and save changes" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0][0].record.expiresAt.toISOString())
      .toBe("2099-12-31T00:00:00.000Z");
  });

  it("explains that an elapsed posting is expired rather than echoing its stale submitted status", async () => {
    mocks.posting = { ...live, expiresAt: new Date(0) };
    render(<CreatePostingPage editPostingId="posting1" onNavigate={mocks.navigate} />);
    expect(await screen.findByText("This posting has expired and can no longer be edited.")).toBeTruthy();
    expect(screen.queryByText(/Its status is submitted/)).toBeNull();
  });
});

const funding = {
  id: "funding1",
  opportunityType: "open-funding",
  ownerId: account,
  organisation: "Singapore Management University",
  title: "Resilient supply chains",
  fundingThesis: "Fund research into resilient supply chains.",
  eligibilityNotes: "Universities and research organisations may apply.",
  status: "submitted",
  categories: ["quantum"],
  tags: ["Quantum"],
  amount: 250000,
  currency: "USDT",
  attachments: [],
  proposalCount: 0,
  createdAt: new Date("2026-09-01T10:00:00Z"),
  expiresAt: new Date("2099-12-01T00:00:00Z"),
};

describe("editing a published funding opportunity", () => {
  it("does not sign an edit when a proposal is selected after the form loads", async () => {
    mocks.posting = { ...funding };
    render(<CreateFundingOpportunityPage editOpportunityId="funding1" onNavigate={mocks.navigate} />);
    await screen.findByRole("heading", { name: "Edit your funding opportunity" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Corrected title" } });
    mocks.matching.mockResolvedValue({ matching: { status: "awaiting_confirmation", totalFundedMinor: 1000 }, proposals: [] });
    fireEvent.click(screen.getByRole("button", { name: "Sign and save changes" }));
    expect(await screen.findByText(/Funding or matching has started/)).toBeTruthy();
    expect(mocks.fundingAudit).not.toHaveBeenCalled();
    expect(mocks.updateFunding).not.toHaveBeenCalled();
  });

  it("signs updateOpportunity before saving when no proposal has arrived", async () => {
    mocks.posting = { ...funding };
    mocks.updateFunding.mockResolvedValue({ ...funding, title: "Corrected title" });
    render(<CreateFundingOpportunityPage editOpportunityId="funding1" onNavigate={mocks.navigate} />);
    await screen.findByRole("heading", { name: "Edit your funding opportunity" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Corrected title" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and save changes" }));
    await waitFor(() => expect(mocks.fundingAudit).toHaveBeenCalled());
    await waitFor(() => expect(mocks.updateFunding).toHaveBeenCalled());
    expect(mocks.fundingAudit.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.updateFunding.mock.invocationCallOrder[0]);
    expect(await screen.findByText("Funding opportunity updated")).toBeTruthy();
  });

  it("locks the funding thesis after the first proposal and still allows attachments", async () => {
    mocks.posting = { ...funding, proposalCount: 1 };
    render(<CreateFundingOpportunityPage editOpportunityId="funding1" onNavigate={mocks.navigate} />);
    await screen.findByText(/A proposal has already been received/);
    expect(screen.getByText("1. Funding direction").closest("fieldset").disabled).toBe(true);
    expect(screen.getByText("4. Funding and timing").closest("fieldset").disabled).toBe(true);
    expect(screen.getByText("5. Extend the response window").closest("fieldset").disabled).toBe(false);
    expect(screen.getByText("6. Supporting material").closest("fieldset").disabled).toBe(false);
    expect(screen.getByText("Uploader")).toBeTruthy();
  });

  it("extends a funding opportunity from its current absolute deadline", async () => {
    mocks.posting = { ...funding };
    render(<CreateFundingOpportunityPage editOpportunityId="funding1" onNavigate={mocks.navigate} />);
    await screen.findByRole("heading", { name: "Edit your funding opportunity" });
    fireEvent.change(screen.getByLabelText("Extend by"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and save changes" }));
    await waitFor(() => expect(mocks.updateFunding).toHaveBeenCalled());
    expect(mocks.updateFunding.mock.calls[0][0].record.expiresAt.toISOString())
      .toBe("2099-12-31T00:00:00.000Z");
  });

  it("explains that an elapsed funding opportunity is expired rather than echoing its stale submitted status", async () => {
    mocks.posting = { ...funding, expiresAt: new Date(0) };
    render(<CreateFundingOpportunityPage editOpportunityId="funding1" onNavigate={mocks.navigate} />);
    expect(await screen.findByText("This funding opportunity has expired and can no longer be edited.")).toBeTruthy();
    expect(screen.queryByText(/Its status is submitted/)).toBeNull();
  });
});
