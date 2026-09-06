import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS } from "../../src/config/proposal.js";
const mocks = vi.hoisted(() => ({ posting: null, active: null, submit: vi.fn() }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: { id: "0xabc" } }) }));
vi.mock("../../src/lib/postings.js", () => ({ findPosting: async () => mocks.posting }));
vi.mock("../../src/lib/proposals.js", () => ({ findActiveProposal: async () => mocks.active, newProposalId: () => "proposal1", submitProposal: (...args) => mocks.submit(...args) }));
vi.mock("../../src/lib/proposalAudit.js", () => ({ proposalAuditReceipt: () => ({ status: "queued" }) }));
vi.mock("../../src/components/AttachmentUploader.jsx", () => ({ AttachmentUploader: ({ scope, onPendingChange }) => <button type="button" onClick={() => onPendingChange(true)}>Upload {scope} PDF</button> }));
vi.mock("../../src/pages/ProposalDetailPage.jsx", () => ({ default: ({ proposalId }) => <h1>Saved {proposalId}</h1> }));
import CreateProposalPage from "../../src/pages/CreateProposalPage.jsx";
beforeEach(() => { window.scrollTo = vi.fn(); Element.prototype.scrollIntoView = vi.fn(); mocks.posting = { id: "problem1", title: "Routing challenge", status: "submitted", expiresAt: new Date("2099-01-01"), currency: "USDC", amount: 5000 }; mocks.active = null; mocks.submit.mockReset().mockResolvedValue({ id: "proposal1" }); });
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
    await renderForm(); fill(); fireEvent.click(screen.getByRole("button", { name: "Submit proposal" }));
    await screen.findByRole("heading", { name: "Saved proposal1" });
    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0 });
    expect(mocks.submit.mock.calls[0][0].form.category).toBe("quantum-annealing");
  });
  it("requires funding problem framing and states the funder's selection role", async () => {
    mocks.posting.opportunityType = "open-funding";
    await renderForm(); fill(); fireEvent.click(screen.getByRole("button", { name: "Submit proposal" }));
    expect(await screen.findByText("Proposed problem statement is required.")).toBeTruthy();
    expect(mocks.submit).not.toHaveBeenCalled();
    fill(PROBLEM_FRAMING_FIELDS); fireEvent.click(screen.getByRole("button", { name: "Submit proposal" }));
    await screen.findByRole("heading", { name: "Saved proposal1" });
  });
  it("preserves form input after a failed write and permits retry", async () => {
    mocks.submit.mockRejectedValueOnce(new Error("Network unavailable"));
    await renderForm(); fill(); fireEvent.click(screen.getByRole("button", { name: "Submit proposal" }));
    await screen.findByText("Network unavailable");
    expect(screen.getByLabelText("Proposal title").value).toBe("Proposal title content");
    fireEvent.click(screen.getByRole("button", { name: "Submit proposal" }));
    await screen.findByRole("heading", { name: "Saved proposal1" });
  });
  it("blocks expired opportunities, duplicates and pending uploads", async () => {
    mocks.posting.status = "expired"; await renderForm();
    expect(screen.getByRole("button", { name: "Submit proposal" }).disabled).toBe(true);
    cleanup(); mocks.posting.status = "submitted"; mocks.active = { id: "existing" }; await renderForm();
    expect(screen.getByRole("button", { name: "View my proposal" })).toBeTruthy();
    cleanup(); mocks.active = null; await renderForm(); fill(); fireEvent.click(screen.getByText("Upload proposals PDF"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Waiting for attachments…" }).disabled).toBe(true));
  });
});
