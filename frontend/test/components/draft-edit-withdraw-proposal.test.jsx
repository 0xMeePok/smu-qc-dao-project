import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROPOSAL_FIELDS } from "../../src/config/proposal.js";

const account = `0x${"a".repeat(40)}`;
const mocks = vi.hoisted(() => ({
  posting: null, active: null, draft: null, record: null,
  submit: vi.fn(), saveDraft: vi.fn(), update: vi.fn(), withdraw: vi.fn(),
  find: vi.fn(), revisions: [], anchor: vi.fn(), anchorWithdrawal: vi.fn(),
  connected: true, navigate: vi.fn(), receipt: vi.fn(),
}));
vi.mock("wagmi", () => ({ useAccount: () => ({ isConnected: mocks.connected, address: account }) }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: { id: account } }) }));
vi.mock("../../src/lib/postings.js", () => ({ findPosting: async () => mocks.posting }));
vi.mock("../../src/lib/proposals.js", () => ({
  PROPOSAL_STATUS_DRAFT: "draft",
  buildProposalDocument: ({ form }) => ({ ...form, status: "submitted" }),
  updateProposalReceipt: (...args) => mocks.receipt(...args),
  findActiveProposal: async () => mocks.active,
  findProposal: (...args) => mocks.find(...args),
  findProposalDraft: async () => mocks.draft,
  newProposalId: () => "proposal-new",
  submitProposal: (...args) => mocks.submit(...args),
  saveProposalDraft: (...args) => mocks.saveDraft(...args),
  updateProposal: (...args) => mocks.update(...args),
  withdrawProposal: (...args) => mocks.withdraw(...args),
  listProposalRevisions: async () => mocks.revisions,
}));
vi.mock("../../src/lib/proposalAudit.js", () => ({
  anchorProposalAudit: (...args) => mocks.anchor(...args),
  anchorProposalBeforeWrite: (...args) => mocks.anchor(...args),
  anchorProposalWithdrawal: (...args) => mocks.anchorWithdrawal(...args),
  receiptForWrite: (audit) => audit,
  proposalAuditReceipt: (record) => record.audit ?? { status: "queued" },
  readProposalAudit: async () => ({ verified: true }),
}));
vi.mock("../../src/components/AttachmentUploader.jsx", () => ({ AttachmentUploader: () => <p>Attachments</p> }));
vi.mock("../../src/components/ConnectWalletModal.jsx", () => ({ ConnectWalletModal: () => <p>Wallet picker</p> }));
import CreateProposalPage from "../../src/pages/CreateProposalPage.jsx";
import ProposalDetailPage from "../../src/pages/ProposalDetailPage.jsx";

const posting = { id: "problem1", ownerId: `0x${"b".repeat(40)}`, title: "Routing challenge", status: "submitted", expiresAt: new Date("2099-01-01"), currency: "USDC", amount: 5000 };
const submittedProposal = {
  id: "proposal1", researcherId: account, postingOwnerId: posting.ownerId, problemId: "problem1",
  title: "Saved routing study", summary: "Baseline and validation", amount: 1200,
  currency: "USDC", category: "quantum-annealing", status: "submitted", createdAt: new Date(),
  ...Object.fromEntries(PROPOSAL_FIELDS.slice(2).map(([key]) => [key, `${key} content`])),
};
beforeEach(() => {
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  mocks.posting = posting; mocks.active = null; mocks.draft = null; mocks.record = null; mocks.revisions = [];
  mocks.submit.mockReset().mockResolvedValue({ id: "proposal-new" });
  mocks.saveDraft.mockReset().mockResolvedValue({ id: "proposal-new", status: "draft", updatedAt: new Date("2026-09-08T10:00:00Z") });
  mocks.update.mockReset().mockResolvedValue({ id: "proposal1", status: "submitted" });
  mocks.withdraw.mockReset().mockResolvedValue(undefined);
  mocks.find.mockReset().mockResolvedValue(submittedProposal);
  mocks.connected = true;
  mocks.navigate.mockReset();
  mocks.receipt.mockReset().mockResolvedValue(undefined);
  mocks.anchor.mockReset().mockResolvedValue({ status: "confirmed", transactionHash: `0x${"3".repeat(64)}`, blockNumber: 88 });
  mocks.anchorWithdrawal.mockReset().mockResolvedValue({ transactionHash: `0x${"4".repeat(64)}` });
});
afterEach(cleanup);

describe("saving a proposal over several sittings", () => {
  it("saves an unfinished form without demanding the missing fields", async () => {
    render(<CreateProposalPage postingId="problem1" onNavigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "Submit a proposal" });
    fireEvent.change(screen.getByLabelText("Proposal title"), { target: { value: "Routing, first pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(mocks.saveDraft).toHaveBeenCalledTimes(1));
    const [call] = mocks.saveDraft.mock.calls[0];
    expect(call.form.title).toBe("Routing, first pass");
    // First save creates the record; the page must not then try to create it again.
    expect(call.exists).toBe(false);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(await screen.findByText(/Draft saved/)).toBeTruthy();
    expect(screen.getByText(/Only you can see it/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(mocks.saveDraft).toHaveBeenCalledTimes(2));
    expect(mocks.saveDraft.mock.calls[1][0].exists).toBe(true);
  });

  it("resumes the saved draft in place rather than starting a second one", async () => {
    mocks.draft = { id: "draft-1", status: "draft", title: "Routing, first pass", methodology: "Half a paragraph", updatedAt: new Date("2026-09-08T10:00:00Z") };
    render(<CreateProposalPage postingId="problem1" onNavigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "Resume your draft" });
    expect(screen.getByLabelText("Proposal title").value).toBe("Routing, first pass");
    expect(screen.getByLabelText("Technical methodology").value).toBe("Half a paragraph");
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    // The draft's own id, not a fresh one: its attachments and audit entity are
    // both derived from it, so a new id would orphan them.
    await waitFor(() => expect(mocks.saveDraft.mock.calls[0][0].proposalId).toBe("draft-1"));
    expect(mocks.saveDraft.mock.calls[0][0].exists).toBe(true);
  });

  it("submits a resumed draft in place instead of creating a second record", async () => {
    mocks.draft = { id: "draft-1", status: "draft", title: "Routing", updatedAt: new Date() };
    render(<CreateProposalPage postingId="problem1" onNavigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "Resume your draft" });
    for (const [, label] of PROPOSAL_FIELDS) fireEvent.change(screen.getByLabelText(label), { target: { value: `${label} content` } });
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "Quantum annealing" }));
    fireEvent.change(screen.getByLabelText("Requested funding amount (USDC)"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit proposal" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0]).toMatchObject({ proposalId: "draft-1", fromDraft: true });
  });

  it("offers a draft to resume even though an earlier proposal is still active", async () => {
    mocks.active = { id: "proposal1" };
    mocks.draft = { id: "draft-1", status: "draft", title: "A second idea", updatedAt: new Date() };
    render(<CreateProposalPage postingId="problem1" onNavigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "Resume your draft" });
    expect(screen.queryByText("You already have an active proposal")).toBeNull();
  });
});

describe("correcting a proposal before it is evaluated", () => {
  it("loads the submitted proposal into the form and saves it as an edit", async () => {
    render(<CreateProposalPage proposalId="proposal1" onNavigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "Edit your proposal" });
    expect(screen.getByLabelText("Proposal title").value).toBe("Saved routing study");
    // The author is told what the edit costs before they make it.
    expect(screen.getByText(/records the edit/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save as draft" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Delivery timeline"), { target: { value: "16 weeks instead of 12" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and save changes" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update.mock.calls[0][0].form.timeline).toBe("16 weeks instead of 12");
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("refuses to open a proposal that evaluation has already reached", async () => {
    mocks.find.mockResolvedValue({ ...submittedProposal, status: "under_review" });
    render(<CreateProposalPage proposalId="proposal1" onNavigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "This proposal can no longer be edited" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/locked once evaluation begins/);
  });

  it("says the proposal is unavailable when an edit cannot be loaded", async () => {
    mocks.find.mockResolvedValue(null);
    render(<CreateProposalPage proposalId="proposal1" onNavigate={mocks.navigate} />);
    expect(await screen.findByRole("heading", { name: "Proposal unavailable" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/could not be found or you do not have access/);
    fireEvent.click(screen.getByRole("button", { name: "My proposals" }));
    expect(mocks.navigate).toHaveBeenCalledWith("proposals");
  });

  it("offers the edit only while the proposal is still submitted", async () => {
    render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Edit proposal" })).toBeTruthy();
    cleanup();
    mocks.find.mockResolvedValue({ ...submittedProposal, status: "under_review" });
    render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
    await screen.findByRole("heading", { name: submittedProposal.title });
    expect(screen.queryByRole("button", { name: "Edit proposal" })).toBeNull();
    expect(screen.getByRole("button", { name: "Withdraw proposal" })).toBeTruthy();
  });
});

describe("withdrawing a proposal", () => {
  it("will not withdraw without a reason, and sends the reason once given", async () => {
    render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw proposal" }));
    await screen.findByRole("heading", { name: "Withdraw this proposal?" });
    fireEvent.click(screen.getByRole("button", { name: "Sign and withdraw" }));
    expect(await screen.findByText("Give a reason for withdrawing this proposal.")).toBeTruthy();
    expect(mocks.withdraw).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Why are you withdrawing?"), { target: { value: "The costing was wrong." } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and withdraw" }));
    await waitFor(() => expect(mocks.withdraw).toHaveBeenCalledWith("proposal1", "The costing was wrong."));
    expect(await screen.findByText("The costing was wrong.")).toBeTruthy();
  });

  it("tells the author the reason is permanent before they commit to it", async () => {
    render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw proposal" }));
    await screen.findByRole("heading", { name: "Withdraw this proposal?" });
    expect(screen.getByText(/cannot be changed afterwards/)).toBeTruthy();
    expect(screen.getByText(/shown to the sponsor/)).toBeTruthy();
  });
});

describe("the edit trail", () => {
  it("shows what changed, who changed it and when", async () => {
    mocks.revisions = [
      { id: "rev2", actor: account, changedFields: [], previousStatus: "submitted", status: "withdrawn", withdrawalReason: "The costing was wrong.", at: new Date("2026-09-08T12:00:00Z") },
      { id: "rev1", actor: account, changedFields: ["timeline", "amount"], previousStatus: "submitted", status: "submitted", at: new Date("2026-09-08T11:00:00Z") },
    ];
    render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Edit history" })).toBeTruthy();
    expect(screen.getByText("Edited after submission")).toBeTruthy();
    expect(screen.getByText("Withdrawn from evaluation")).toBeTruthy();
    // Field labels, not storage keys: the trail is read by people settling a dispute.
    expect(screen.getByText(/Changed: Delivery timeline, Requested amount/)).toBeTruthy();
    expect(screen.getByText(/Recorded by the platform, not by the author/)).toBeTruthy();
  });

  it("stays out of the way when nothing has been edited", async () => {
    render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
    await screen.findByRole("heading", { name: submittedProposal.title });
    await waitFor(() => expect(screen.queryByText("Loading edit history…")).toBeNull());
    expect(screen.queryByRole("heading", { name: "Edit history" })).toBeNull();
  });
});

describe("nothing is written before the transaction confirms", () => {
  it("submits only after the anchor, and writes the record that was hashed", async () => {
    const order = [];
    mocks.anchor.mockImplementation(async () => { order.push("anchor"); return { status: "confirmed", transactionHash: `0x${"3".repeat(64)}`, blockNumber: 88 }; });
    mocks.submit.mockImplementation(async () => { order.push("write"); return { id: "proposal-new" }; });
    render(<CreateProposalPage postingId="problem1" onNavigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "Submit a proposal" });
    for (const [, label] of PROPOSAL_FIELDS) fireEvent.change(screen.getByLabelText(label), { target: { value: `${label} content` } });
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "Quantum annealing" }));
    fireEvent.change(screen.getByLabelText("Requested funding amount (USDC)"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit proposal" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalled());
    expect(order).toEqual(["anchor", "write"]);
    // The record handed to the chain is the record handed to Firestore. Rebuilding
    // between the two would store content the receipt does not describe.
    expect(mocks.submit.mock.calls[0][0].record).toBeTruthy();
    // The receipt follows in its own write: carrying it on the create crossed
    // Firestore's rule expression cap for an open-funding proposal with a file.
    expect(mocks.submit.mock.calls[0][0].audit).toBeUndefined();
    await waitFor(() => expect(mocks.receipt).toHaveBeenCalled());
    expect(mocks.receipt.mock.calls[0][0].audit.transactionHash).toBe(`0x${"3".repeat(64)}`);
  });

  it("still counts the proposal as submitted when only the receipt write fails", async () => {
    // The proposal is saved and the transaction is on-chain; the trigger queues
    // the receipt and the detail page offers a retry. Failing the submission
    // here would tell the author their work was lost when it was not.
    mocks.receipt.mockRejectedValueOnce(new Error("Network unavailable"));
    render(<CreateProposalPage postingId="problem1" onNavigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "Submit a proposal" });
    for (const [, label] of PROPOSAL_FIELDS) fireEvent.change(screen.getByLabelText(label), { target: { value: `${label} content` } });
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "Quantum annealing" }));
    fireEvent.change(screen.getByLabelText("Requested funding amount (USDC)"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and submit proposal" }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalled());
    // The confirmation screen, not an error banner.
    expect(await screen.findByText(/Proposal submitted successfully/)).toBeTruthy();
  });

  it("leaves a submitted proposal untouched when an edit is declined", async () => {
    mocks.anchor.mockRejectedValueOnce(Object.assign(new Error("User rejected"), { code: 4001 }));
    render(<CreateProposalPage proposalId="proposal1" onNavigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "Edit your proposal" });
    fireEvent.change(screen.getByLabelText("Delivery timeline"), { target: { value: "16 weeks" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and save changes" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/declined/i);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("keeps the proposal in evaluation when the withdrawal is declined", async () => {
    mocks.anchorWithdrawal.mockRejectedValueOnce(Object.assign(new Error("User rejected"), { code: 4001 }));
    render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw proposal" }));
    await screen.findByRole("heading", { name: "Withdraw this proposal?" });
    fireEvent.change(screen.getByLabelText("Why are you withdrawing?"), { target: { value: "The costing was wrong." } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and withdraw" }));
    await waitFor(() => expect(mocks.anchorWithdrawal).toHaveBeenCalled());
    // A withdrawal that was never signed is a withdrawal that never happened.
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });

  it("anchors the withdrawal reason before removing it from evaluation", async () => {
    const order = [];
    mocks.anchorWithdrawal.mockImplementation(async () => { order.push("anchor"); return { transactionHash: `0x${"4".repeat(64)}` }; });
    mocks.withdraw.mockImplementation(async () => { order.push("write"); });
    render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw proposal" }));
    await screen.findByRole("heading", { name: "Withdraw this proposal?" });
    fireEvent.change(screen.getByLabelText("Why are you withdrawing?"), { target: { value: "The costing was wrong." } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and withdraw" }));
    await waitFor(() => expect(mocks.withdraw).toHaveBeenCalled());
    expect(order).toEqual(["anchor", "write"]);
    // The exact words that were hashed are the words that get stored.
    expect(mocks.anchorWithdrawal.mock.calls[0][1].reason).toBe("The costing was wrong.");
    expect(mocks.withdraw).toHaveBeenCalledWith("proposal1", "The costing was wrong.");
  });

  it("retries only the Firestore write when the chain already accepted the withdrawal", async () => {
    mocks.withdraw.mockRejectedValueOnce(new Error("Network unavailable"));
    render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw proposal" }));
    await screen.findByRole("heading", { name: "Withdraw this proposal?" });
    fireEvent.change(screen.getByLabelText("Why are you withdrawing?"), { target: { value: "The costing was wrong." } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and withdraw" }));
    expect(await screen.findByText(/will not be asked to sign again/)).toBeTruthy();
    expect(mocks.anchorWithdrawal).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Why are you withdrawing?").disabled).toBe(true);
    expect(screen.getByLabelText("Why are you withdrawing?").value).toBe("The costing was wrong.");
    fireEvent.change(screen.getByLabelText("Why are you withdrawing?"), { target: { value: "A different reason." } });
    expect(screen.getByLabelText("Why are you withdrawing?").value).toBe("The costing was wrong.");
    fireEvent.click(screen.getByRole("button", { name: "Finish saving withdrawal" }));
    await waitFor(() => expect(mocks.withdraw).toHaveBeenCalledTimes(2));
    expect(mocks.anchorWithdrawal).toHaveBeenCalledTimes(1);
    expect(mocks.withdraw.mock.calls[1]).toEqual(["proposal1", "The costing was wrong."]);
    expect(await screen.findByText("The costing was wrong.")).toBeTruthy();
  });

  it("will not sign a withdrawal from the wrong wallet", async () => {
    mocks.connected = false;
    render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw proposal" }));
    await screen.findByRole("heading", { name: "Withdraw this proposal?" });
    fireEvent.change(screen.getByLabelText("Why are you withdrawing?"), { target: { value: "The costing was wrong." } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and withdraw" }));
    expect(await screen.findByText(/Connect the wallet that submitted this proposal/)).toBeTruthy();
    expect(mocks.anchorWithdrawal).not.toHaveBeenCalled();
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });
});

describe("leaving a proposal with unsaved work", () => {
  const start = async () => {
    render(<CreateProposalPage postingId="problem1" onNavigate={mocks.navigate} />);
    await screen.findByRole("heading", { name: "Submit a proposal" });
  };

  it("says nothing when the form was never touched", async () => {
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Back to opportunity" }));
    expect(screen.queryByText(/save this as a draft/i)).toBeNull();
    expect(mocks.navigate).toHaveBeenCalledWith("posting/problem1");
  });

  it("offers to save when work would otherwise be lost", async () => {
    await start();
    fireEvent.change(screen.getByLabelText("Proposal title"), { target: { value: "Half an idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to opportunity" }));
    expect(screen.getByText(/save this as a draft/i)).toBeTruthy();
    expect(screen.getByText(/pick it up from My Proposals later/i)).toBeTruthy();
    // Still on the form: the prompt interrupts the navigation, not the work.
    expect(mocks.navigate).not.toHaveBeenCalledWith("posting/problem1");
  });

  it("saves the draft and then leaves", async () => {
    await start();
    fireEvent.change(screen.getByLabelText("Proposal title"), { target: { value: "Half an idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to opportunity" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as draft and leave" }));
    await waitFor(() => expect(mocks.saveDraft).toHaveBeenCalledTimes(1));
    expect(mocks.saveDraft.mock.calls[0][0].form.title).toBe("Half an idea");
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("posting/problem1"));
  });

  it("stays put when the save fails, rather than losing the work it offered to keep", async () => {
    mocks.saveDraft.mockRejectedValueOnce(new Error("Network unavailable"));
    await start();
    fireEvent.change(screen.getByLabelText("Proposal title"), { target: { value: "Half an idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to opportunity" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as draft and leave" }));
    await waitFor(() => expect(mocks.saveDraft).toHaveBeenCalled());
    expect(mocks.navigate).not.toHaveBeenCalledWith("posting/problem1");
    expect(screen.getByLabelText("Proposal title").value).toBe("Half an idea");
  });

  it("leaves without saving when told to discard", async () => {
    await start();
    fireEvent.change(screen.getByLabelText("Proposal title"), { target: { value: "Half an idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to opportunity" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("posting/problem1"));
    expect(mocks.saveDraft).not.toHaveBeenCalled();
  });

  it("stays put when the prompt is dismissed", async () => {
    await start();
    fireEvent.change(screen.getByLabelText("Proposal title"), { target: { value: "Half an idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to opportunity" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText(/save this as a draft/i)).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalledWith("posting/problem1");
    expect(screen.getByLabelText("Proposal title").value).toBe("Half an idea");
  });

  it("does not prompt again once the draft has just been saved", async () => {
    await start();
    fireEvent.change(screen.getByLabelText("Proposal title"), { target: { value: "Half an idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await screen.findByText(/Draft saved/);
    fireEvent.click(screen.getByRole("button", { name: "Back to opportunity" }));
    expect(screen.queryByText(/save this as a draft/i)).toBeNull();
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("posting/problem1"));
  });

  it("prompts again once something changes after the save", async () => {
    await start();
    fireEvent.change(screen.getByLabelText("Proposal title"), { target: { value: "Half an idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await screen.findByText(/Draft saved/);
    fireEvent.change(screen.getByLabelText("Proposal title"), { target: { value: "A better idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to opportunity" }));
    // Once a draft exists the choice is a rollback, not a total loss, and the
    // wording follows what is actually at stake.
    expect(screen.getByText(/not in the saved draft/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeTruthy();
  });

  it("does not prompt when a resumed draft is left untouched", async () => {
    mocks.draft = { id: "draft-1", status: "draft", title: "Routing, first pass", updatedAt: new Date() };
    render(<CreateProposalPage postingId="problem1" onNavigate={mocks.navigate} />);
    await screen.findByRole("heading", { name: "Resume your draft" });
    fireEvent.click(screen.getByRole("button", { name: "Back to opportunity" }));
    expect(screen.queryByText(/save this as a draft/i)).toBeNull();
  });

  it("never offers a draft while editing a submitted proposal", async () => {
    // There is no draft to save at that point, and the record on screen is
    // already the saved one.
    render(<CreateProposalPage proposalId="proposal1" onNavigate={mocks.navigate} />);
    await screen.findByRole("heading", { name: "Edit your proposal" });
    fireEvent.change(screen.getByLabelText("Delivery timeline"), { target: { value: "16 weeks" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to proposal" }));
    expect(screen.queryByText(/save this as a draft/i)).toBeNull();
    expect(mocks.navigate).toHaveBeenCalledWith("proposal/proposal1");
  });
});
