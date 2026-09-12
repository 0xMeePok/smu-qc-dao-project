import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS } from "../../src/config/proposal.js";
const mocks = vi.hoisted(() => ({ posting: null, active: null, draft: null, record: null, connected: true, submit: vi.fn(), saveDraft: vi.fn(), update: vi.fn(), anchor: vi.fn(), receipt: vi.fn() }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: { id: "0xabc" } }) }));
vi.mock("../../src/lib/postings.js", () => ({ findPosting: async () => mocks.posting }));
vi.mock("../../src/lib/proposals.js", () => ({
  PROPOSAL_STATUS_DRAFT: "draft",
  buildProposalDocument: ({ form }) => ({ ...form, status: "submitted" }),
  updateProposalReceipt: (...args) => mocks.receipt(...args),
  findActiveProposal: async () => mocks.active,
  findProposal: async () => mocks.record,
  findProposalDraft: async () => mocks.draft,
  newProposalId: () => "proposal1",
  submitProposal: (...args) => mocks.submit(...args),
  saveProposalDraft: (...args) => mocks.saveDraft(...args),
  updateProposal: (...args) => mocks.update(...args),
}));
vi.mock("wagmi", () => ({ useAccount: () => ({ isConnected: mocks.connected, address: "0xabc" }) }));
vi.mock("../../src/lib/proposalAudit.js", () => ({
  proposalAuditReceipt: () => ({ status: "queued" }),
  anchorProposalBeforeWrite: (...args) => mocks.anchor(...args),
  receiptForWrite: (audit) => audit,
}));
vi.mock("../../src/components/AttachmentUploader.jsx", () => ({ AttachmentUploader: ({ scope, onPendingChange }) => <button type="button" onClick={() => onPendingChange(true)}>Upload {scope} PDF</button> }));
vi.mock("../../src/pages/ProposalDetailPage.jsx", () => ({ default: ({ proposalId }) => <h1>Saved {proposalId}</h1> }));
import CreateProposalPage from "../../src/pages/CreateProposalPage.jsx";
beforeEach(() => { window.scrollTo = vi.fn(); Element.prototype.scrollIntoView = vi.fn(); mocks.posting = { id: "problem1", title: "Routing challenge", status: "submitted", expiresAt: new Date("2099-01-01"), currency: "USDC", amount: 5000 }; mocks.active = null; mocks.draft = null; mocks.record = null;
  mocks.submit.mockReset().mockResolvedValue({ id: "proposal1" });
  mocks.saveDraft.mockReset().mockResolvedValue({ id: "proposal1", status: "draft", updatedAt: new Date("2026-09-08T10:00:00Z") });
  mocks.update.mockReset().mockResolvedValue({ id: "proposal1", status: "submitted" });
  mocks.connected = true;
  mocks.receipt.mockReset().mockResolvedValue(undefined);
  mocks.anchor.mockReset().mockResolvedValue({ status: "confirmed", transactionHash: `0x${"3".repeat(64)}`, blockNumber: 88 }); });
afterEach(cleanup);
const renderForm = async () => { render(<CreateProposalPage postingId="problem1" onNavigate={vi.fn()} />); await screen.findByRole("heading", { name: "Submit a proposal" }); };
const fill = (extra = []) => {
  for (const [, label] of [...PROPOSAL_FIELDS, ...extra]) fireEvent.change(screen.getByLabelText(label), { target: { value: `${label} content` } });
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name: "Quantum annealing" }));
  fireEvent.change(screen.getByLabelText("Requested funding amount (USDC)"), { target: { value: "1000" } });
};
describe("proposal submission form", () => {
  it("submits a complete problem proposal and shows saved confirmation", async () => {
    await renderForm(); fill(); fireEvent.click(screen.getByRole("button", { name: "Sign and submit proposal" }));
    await screen.findByRole("heading", { name: "Saved proposal1" });
    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0 });
    expect(mocks.submit.mock.calls[0][0].form.category).toBe("quantum-annealing");
  });
  it("requires funding problem framing and states the funder's selection role", async () => {
    mocks.posting.opportunityType = "open-funding";
    await renderForm(); fill(); fireEvent.click(screen.getByRole("button", { name: "Sign and submit proposal" }));
    expect(await screen.findByText("Proposed problem statement is required.")).toBeTruthy();
    expect(mocks.submit).not.toHaveBeenCalled();
    fill(PROBLEM_FRAMING_FIELDS); fireEvent.click(screen.getByRole("button", { name: "Sign and submit proposal" }));
    await screen.findByRole("heading", { name: "Saved proposal1" });
  });
  it("preserves form input after a failed write and permits retry", async () => {
    mocks.submit.mockRejectedValueOnce(new Error("Network unavailable"));
    await renderForm(); fill(); fireEvent.click(screen.getByRole("button", { name: "Sign and submit proposal" }));
    // The anchor already succeeded, so the author has paid for a transaction.
    // Saying only "network unavailable" would read as nothing having happened.
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toMatch(/transaction was confirmed, but saving the proposal failed/);
    expect(banner.textContent).toMatch(/Network unavailable/);
    expect(screen.getByLabelText("Proposal title").value).toBe("Proposal title content");
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit proposal" }));
    await screen.findByRole("heading", { name: "Saved proposal1" });
  });
  it.each([
    Object.assign(new Error("User rejected"), { code: 4001 }),
    { message: "Transaction execution failed", cause: { cause: { code: 4001 } } },
    { message: "User denied transaction signature" },
  ])("[QCDAO-79] shows and focuses wallet cancellation, preserves input, and permits retry: %s", async (error) => {
    mocks.anchor.mockRejectedValueOnce(error);
    await renderForm(); fill(); fireEvent.click(screen.getByRole("button", { name: "Sign and submit proposal" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/wallet transaction was declined/i);
    // The whole point of the ordering: a declined signature leaves no proposal.
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Proposal title").value).toBe("Proposal title content");
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit proposal" }));
    await screen.findByRole("heading", { name: "Saved proposal1" });
  });
  it("refuses to start without the signing wallet connected", async () => {
    mocks.connected = false;
    await renderForm(); fill(); fireEvent.click(screen.getByRole("button", { name: "Sign and submit proposal" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Connect the wallet/);
    expect(mocks.anchor).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("[QCDAO-79] explains cancellation of a pending transaction without saving or losing the form", async () => {
    mocks.anchor.mockRejectedValueOnce({ code: "AUDIT_TRANSACTION_CANCELLED", message: "Cancelled", transactionHash: `0x${"3".repeat(64)}` });
    await renderForm(); fill(); fireEvent.click(screen.getByRole("button", { name: "Sign and submit proposal" }));
    expect((await screen.findByRole("alert")).textContent).toContain("pending verification transaction was cancelled in your wallet");
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Proposal title").value).toBe("Proposal title content");
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    expect(screen.getByRole("button", { name: "Sign and submit proposal" }).disabled).toBe(false);
  });
  it("blocks expired opportunities, duplicates and pending uploads", async () => {
    mocks.posting.status = "expired"; await renderForm();
    expect(screen.getByRole("button", { name: "Sign and submit proposal" }).disabled).toBe(true);
    cleanup(); mocks.posting.status = "submitted"; mocks.active = { id: "existing" }; await renderForm();
    expect(screen.getByRole("button", { name: "View my proposal" })).toBeTruthy();
    cleanup(); mocks.active = null; await renderForm(); fill(); fireEvent.click(screen.getByText("Upload proposals PDF"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Waiting for attachments…" }).disabled).toBe(true));
  });
});
