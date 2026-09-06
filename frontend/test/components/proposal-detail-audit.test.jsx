import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ connected: false, anchor: vi.fn(), find: vi.fn() }));
const account = `0x${"a".repeat(40)}`;
vi.mock("wagmi", () => ({ useAccount: () => ({ isConnected: mocks.connected, address: `0x${"a".repeat(40)}` }) }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: { id: `0x${"a".repeat(40)}` } }) }));
vi.mock("../../src/lib/proposals.js", () => ({ findProposal: (...args) => mocks.find(...args), withdrawProposal: vi.fn() }));
vi.mock("../../src/lib/proposalAudit.js", () => ({
  anchorProposalAudit: (...args) => mocks.anchor(...args), proposalAuditReceipt: (record) => record.audit,
  readProposalAudit: async () => ({ verified: true }),
}));
vi.mock("../../src/components/ConnectWalletModal.jsx", () => ({ ConnectWalletModal: () => <p>Wallet picker</p> }));
import ProposalDetailPage from "../../src/pages/ProposalDetailPage.jsx";
const record = { id: "proposal1", researcherId: account, title: "Saved routing study", summary: "Baseline and validation", amount: 1200.25,
  currency: "USDC", category: "quantum-annealing", status: "submitted", createdAt: new Date(),
  audit: { schemaVersion: 1, entityId: `0x${"1".repeat(64)}`, contentHash: `0x${"2".repeat(64)}`, attemptCount: 0, status: "queued", transactionHash: "" } };
beforeEach(() => { mocks.connected = false; mocks.anchor.mockReset(); mocks.find.mockReset().mockResolvedValue(record); });
afterEach(cleanup);
it("keeps a successfully saved proposal visible when its wallet is disconnected", async () => {
  render(<ProposalDetailPage proposalId="proposal1" onNavigate={vi.fn()} autoAnchor />);
  expect(await screen.findByRole("heading", { name: record.title })).toBeTruthy();
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
  expect(screen.getByRole("button", { name: "Start verification" })).toBeTruthy();
  callback({ ...record.audit, status: "failed" });
  await waitFor(() => expect(screen.getByText(next.audit.contentHash)).toBeTruthy());
  expect(screen.queryByText("Proposal saved; verification needs attention")).toBeNull();
});
