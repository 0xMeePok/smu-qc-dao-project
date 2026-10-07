import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INDEPENDENT_PROPOSAL_FIELDS } from "../../src/config/proposal.js";

const mocks = vi.hoisted(() => ({ anchor: vi.fn(), submit: vi.fn(), saveDraft: vi.fn() }));
const account = `0x${"a".repeat(40)}`;
const listing = { status: "confirmed", transactionHash: `0x${"1".repeat(64)}`, blockNumber: 88 };
const escrow = { status: "pending", transactionHash: `0x${"2".repeat(64)}` };
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: { id: `0x${"a".repeat(40)}` } }) }));
vi.mock("wagmi", async importOriginal => ({ ...await importOriginal(), useAccount: () => ({ isConnected: true, address: `0x${"a".repeat(40)}` }) }));
vi.mock("../../src/lib/proposals.js", async importOriginal => ({
  ...await importOriginal(), newProposalId: () => "independent-form", findProposal: async () => null,
  submitIndependentProposal: (...args) => mocks.submit(...args),
  saveIndependentProposalDraft: (...args) => mocks.saveDraft(...args),
}));
vi.mock("../../src/lib/proposalAudit.js", () => ({
  anchorProposalBeforeWrite: (...args) => mocks.anchor(...args),
  receiptForWrite: audit => audit?.status === "confirmed" ? { ...audit, status: "pending" } : audit,
}));
vi.mock("../../src/components/AttachmentUploader.jsx", () => ({ AttachmentUploader: ({ onPendingChange }) => {
  React.useEffect(() => { onPendingChange(0); }, []);
  return null;
} }));
vi.mock("../../src/pages/ProposalDetailPage.jsx", () => ({ default: ({ proposalId }) => <h1>Published {proposalId}</h1> }));
import CreateIndependentProposalPage from "../../src/pages/CreateIndependentProposalPage.jsx";

beforeEach(() => {
  window.scrollTo = vi.fn(); Element.prototype.scrollIntoView = vi.fn();
  window.history.replaceState({}, "", "#/create-proposal");
  mocks.anchor.mockReset().mockResolvedValue(listing);
  mocks.submit.mockReset().mockResolvedValue({ id: "independent-form" });
  mocks.saveDraft.mockReset();
});
afterEach(cleanup);

async function form() {
  render(<CreateIndependentProposalPage onNavigate={vi.fn()} />);
  await screen.findByRole("heading", { name: "Publish an independent proposal" });
  for (const [, label] of INDEPENDENT_PROPOSAL_FIELDS) {
    fireEvent.change(screen.getByLabelText(label), { target: { value: `${label} content` } });
  }
  fireEvent.click(screen.getByRole("combobox", { name: "Quantum or quantum-adjacent category" }));
  fireEvent.click(screen.getByRole("option", { name: "Quantum annealing" }));
  fireEvent.change(screen.getByLabelText("Maturity or readiness level"), { target: { value: "pilot" } });
  fireEvent.change(screen.getByLabelText("Indicative funding sought"), { target: { value: "100" } });
  fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USDC" } });
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
}

function failAfterListing({ pendingListing = false, pendingEscrow = false } = {}) {
  const audit = pendingListing ? { ...listing, status: "failed" } : listing;
  const second = pendingEscrow ? escrow : { status: "failed", transactionHash: "" };
  const error = Object.assign(new Error(pendingEscrow || pendingListing ? "Failed to fetch" : "User rejected"), {
    ...(pendingEscrow || pendingListing ? {} : { code: 4001 }), listingAudit: audit,
    ...(pendingListing ? {} : { escrowAudit: second }),
  });
  mocks.anchor.mockImplementationOnce(async (_record, options) => {
    options.onChange(audit);
    if (!pendingListing) options.onEscrowChange(second);
    throw error;
  });
  return { audit, second };
}

describe("independent publication recovery feedback", () => {
  it("keeps 'nothing submitted' accurate when the provider fails before the first signature", async () => {
    mocks.anchor.mockRejectedValueOnce(new Error("Failed to fetch"));
    await form(); fireEvent.click(screen.getByRole("button", { name: "Sign and publish proposal" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Nothing was submitted/);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Proposal title").closest("fieldset").disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Sign and publish proposal" }).disabled).toBe(false);
  });

  it("explains the confirmed first transaction after a declined escrow signature and reuses it on retry", async () => {
    const { audit, second } = failAfterListing();
    await form(); fireEvent.click(screen.getByRole("button", { name: "Sign and publish proposal" }));
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toMatch(/listing transaction is confirmed/);
    expect(banner.textContent).toMatch(/escrow signature was declined/);
    expect(banner.textContent).toMatch(/proposal has not been published/);
    expect(banner.textContent).not.toMatch(/Nothing was submitted/);
    expect(screen.getByText(/Recovery references are held only on this page/)).toBeTruthy();
    expect(screen.getByLabelText("Proposal title").value).toBe("Proposal title content");
    expect(screen.getByLabelText("Proposal title").closest("fieldset").disabled).toBe(true);
    expect(mocks.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry publication" }));
    await screen.findByRole("heading", { name: "Published independent-form" });
    expect(mocks.anchor.mock.calls[1][0].audit).toEqual(audit);
    expect(mocks.anchor.mock.calls[1][1].escrowAudit).toEqual(second);
    expect(mocks.submit.mock.calls[0][0].audit).toEqual({ ...listing, status: "pending" });
  });

  it("preserves both transaction references and waits for the same escrow hash after a receipt outage", async () => {
    failAfterListing({ pendingEscrow: true });
    await form(); fireEvent.click(screen.getByRole("button", { name: "Sign and publish proposal" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/another signature will not be requested while its result is unknown/);
    expect(screen.getByText(listing.transactionHash)).toBeTruthy();
    expect(screen.getByText(escrow.transactionHash)).toBeTruthy();
    expect(mocks.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry publication" }));
    await screen.findByRole("heading", { name: "Published independent-form" });
    expect(mocks.anchor.mock.calls[1][1].escrowAudit.transactionHash).toBe(escrow.transactionHash);
    expect(mocks.anchor.mock.calls[1][0].researcherId).toBe(account);
  });

  it("retains the first transaction reference when listing confirmation fails before escrow starts", async () => {
    const { audit } = failAfterListing({ pendingListing: true });
    await form(); fireEvent.click(screen.getByRole("button", { name: "Sign and publish proposal" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/listing transaction was submitted, but its confirmation is still pending/);
    expect(mocks.submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry publication" }));
    await screen.findByRole("heading", { name: "Published independent-form" });
    expect(mocks.anchor.mock.calls[1][0].audit).toEqual(audit);
    expect(mocks.anchor.mock.calls[1][1].escrowAudit).toBeNull();
  });
});
