import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proposal: vi.fn(), grant: vi.fn(), write: vi.fn(), sync: vi.fn(), confirm: vi.fn(), escrow: vi.fn(), history: vi.fn(),
}));
const account = `0x${"a".repeat(40)}`, hash = `0x${"1".repeat(64)}`;
vi.mock("wagmi", async importOriginal => ({ ...await importOriginal(), useAccount: () => ({ address: `0x${"a".repeat(40)}`, isConnected: true, chainId: 421614 }) }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: { id: `0x${"a".repeat(40)}`, roles: ["researcher"] } }) }));
vi.mock("../../src/lib/proposals.js", () => ({ findProposal: (...args) => mocks.proposal(...args), withdrawProposal: vi.fn() }));
vi.mock("../../src/lib/openFunding.js", () => ({
  openFundingSupported: () => true, getOpenFundingSummary: (...args) => mocks.grant(...args),
  writeOpenFundingAction: (...args) => mocks.write(...args), syncOpenFunding: (...args) => mocks.sync(...args),
}));
vi.mock("../../src/lib/escrow.js", () => ({
  readEscrow: (...args) => mocks.escrow(...args), confirmEscrowTransaction: (...args) => mocks.confirm(...args),
  escrowErrorMessage: error => error.message, hashEscrowEvidence: vi.fn(), writeEscrowAction: vi.fn(),
}));
vi.mock("../../src/lib/escrowFunding.js", async importOriginal => ({ ...await importOriginal(),
  getEscrowFundingHistory: (...args) => mocks.history(...args), prepareEscrowDeposit: vi.fn(), syncEscrowFunding: vi.fn(), startEscrowSettlement: vi.fn(),
}));
vi.mock("../../src/components/AuditReceipt.jsx", () => ({ AuditReceipt: () => null }));
vi.mock("../../src/components/VerifiedBadge.jsx", () => ({ VerifiedBadge: () => null }));
vi.mock("../../src/components/OwnerReviewPanel.jsx", () => ({ OwnerReviewPanel: () => null }));
vi.mock("../../src/components/ProposalRevisionTrail.jsx", () => ({ ProposalRevisionTrail: () => null }));
vi.mock("../../src/components/ReportableComments.jsx", () => ({ ReportableComments: () => null }));
vi.mock("../../src/components/ReportContentButton.jsx", () => ({ ContentModerationNotice: () => null, ReportContentButton: () => null }));
vi.mock("../../src/components/ConnectWalletModal.jsx", () => ({ ConnectWalletModal: () => null }));
vi.mock("../../src/lib/proposalAudit.js", () => ({ proposalAuditReceipt: record => record.audit, anchorProposalAudit: vi.fn(), anchorProposalWithdrawal: vi.fn(), readProposalAudit: vi.fn() }));

import ProposalDetailPage from "../../src/pages/ProposalDetailPage.jsx";

const proposal = {
  id: "solution", problemId: "grant", researcherId: account, postingOwnerId: `0x${"d".repeat(40)}`,
  opportunityType: "open-funding", title: "Grant-funded solution", status: "submitted", amount: 50000, currency: "USDC",
  audit: { status: "confirmed" }, fundingTerms: { trancheBps: [5000, 5000], reviewWindows: [604800, 604800], funderVoting: false },
};
let accepted;
const escrow = () => ({
  address: `0x${"b".repeat(40)}`, isGrant: true, state: accepted ? 1 : 0, decimals: 6, symbol: "USDC",
  fundingTarget: 50000000000n, totalDeposited: accepted ? 50000000000n : 0n, totalReleased: 0n,
  outstandingBalance: accepted ? 50000000000n : 0n, remaining: accepted ? 0n : 50000000000n,
  approvalDeadline: 2000000000n, expiresAt: 2000000000n, ownerApproved: accepted, solutionApproved: accepted,
  roles: { proposalOwner: true }, can: {}, wallet: { contribution: 0n, depositor: {} }, currentMilestone: { evidenceHash: `0x${"0".repeat(64)}` },
});
beforeEach(() => {
  sessionStorage.clear(); vi.clearAllMocks(); accepted = false;
  mocks.proposal.mockReset().mockResolvedValue(proposal);
  mocks.grant.mockReset().mockImplementation(async () => ({
    supported: true, poolAddress: `0x${"c".repeat(40)}`, tokenSymbol: "USDC", tokenDecimals: 6,
    totalDeposited: "100000000000", totalAllocated: accepted ? "50000000000" : "0",
    totalReserved: accepted ? "0" : "50000000000", available: "50000000000",
    selections: [{ proposalId: proposal.id, title: proposal.title, amountBaseUnits: "50000000000", status: accepted ? "accepted" : "pending", canAccept: !accepted }],
  }));
  mocks.write.mockReset().mockImplementation(async () => { accepted = true; return { transactionHash: hash }; });
  mocks.confirm.mockReset().mockImplementation(async () => { accepted = true; return { transactionHash: hash }; });
  mocks.sync.mockReset().mockResolvedValue({});
  mocks.escrow.mockReset().mockImplementation(async () => escrow());
  mocks.history.mockReset().mockImplementation(async () => ({ events: accepted ? [{
    id: "grant-deposit", type: "escrow_Deposited", amountBaseUnits: "50000000000", tokenDecimals: 6, tokenSymbol: "USDC", transactionHash: hash,
  }] : [] }));
});
afterEach(cleanup);

it.each([false, true])("refreshes the adjacent canonical escrow and funding audit after grant acceptance (recovery=%s)", async recovery => {
  if (recovery) mocks.write.mockImplementation(async input => {
    input.onProgress({ status: "pending", action: "accept", transactionHash: hash });
    throw new Error("Confirmation unavailable");
  });
  render(<ProposalDetailPage proposalId={proposal.id} initialTab="funding" onNavigate={vi.fn()} />);
  await screen.findByText("Waiting for grant funding");
  expect(screen.getByText("0 USDC / 50000 USDC")).toBeTruthy();
  expect(mocks.escrow).toHaveBeenCalledTimes(1);
  fireEvent.click(await screen.findByRole("button", { name: "Accept grant" }));
  if (recovery) {
    fireEvent.click(await screen.findByRole("button", { name: "Check transaction" }));
    expect(mocks.confirm).toHaveBeenCalledWith(hash, { confirmations: 2 });
  }
  await screen.findByText("50000 USDC / 50000 USDC");
  expect(screen.queryByText("Waiting for grant funding")).toBeNull();
  expect(screen.getByText("Upfront payment pending")).toBeTruthy();
  await screen.findByRole("row", { name: /Deposited.*50000 USDC/ });
  expect(mocks.escrow).toHaveBeenCalledTimes(2);
  expect(mocks.history).toHaveBeenCalledTimes(2);
  expect(mocks.history).toHaveBeenLastCalledWith({ proposalId: proposal.id });
  expect(mocks.write).toHaveBeenCalledTimes(1);
});

it("refreshes canonical escrow even when a confirmed grant's backend synchronization is unavailable", async () => {
  mocks.sync.mockRejectedValue(new Error("Funding synchronization unavailable"));
  render(<ProposalDetailPage proposalId={proposal.id} initialTab="funding" onNavigate={vi.fn()} />);
  await screen.findByText("Waiting for grant funding");
  fireEvent.click(await screen.findByRole("button", { name: "Accept grant" }));
  await screen.findByText("Funding synchronization unavailable");
  await screen.findByText("50000 USDC / 50000 USDC");
  expect(mocks.escrow).toHaveBeenCalledTimes(2);
  expect(mocks.write).toHaveBeenCalledTimes(1);
});

it("keeps the current escrow snapshot while grant acceptance remains unconfirmed", async () => {
  mocks.write.mockImplementation(async input => {
    input.onProgress({ status: "pending", action: "accept", transactionHash: hash });
    throw new Error("Confirmation unavailable");
  });
  render(<ProposalDetailPage proposalId={proposal.id} initialTab="funding" onNavigate={vi.fn()} />);
  await screen.findByText("Waiting for grant funding");
  fireEvent.click(await screen.findByRole("button", { name: "Accept grant" }));
  await screen.findByRole("button", { name: "Check transaction" });
  await waitFor(() => expect(screen.getByText("0 USDC / 50000 USDC")).toBeTruthy());
  expect(mocks.escrow).toHaveBeenCalledTimes(1);
  expect(mocks.history).toHaveBeenCalledTimes(1);
});
