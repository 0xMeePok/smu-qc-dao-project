import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), confirm: vi.fn(), load: vi.fn(), save: vi.fn(), account: null, user: null }));
vi.mock("wagmi", () => ({ useAccount: () => mocks.account }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../src/lib/escrow.js", () => ({ readEscrow: (...args) => mocks.read(...args), writeEscrowAction: (...args) => mocks.write(...args),
  confirmEscrowTransaction: (...args) => mocks.confirm(...args), escrowErrorMessage: error => error.message,
  hashEscrowEvidence: evidence => `0x${(evidence.summary === "Delivery complete" ? "1" : "2").repeat(64)}` }));
vi.mock("../../src/lib/escrowEvidence.js", () => ({ loadEscrowEvidence: (...args) => mocks.load(...args), saveEscrowEvidence: (...args) => mocks.save(...args) }));
vi.mock("../../src/components/ConnectWalletModal.jsx", () => ({ ConnectWalletModal: () => <p>Wallet connection dialog</p> }));
import { EscrowFundingPanel, EscrowFundingView } from "../../src/components/EscrowFundingPanel.jsx";
const account = `0x${"a".repeat(40)}`, hash = `0x${"1".repeat(64)}`, selectionId = `0x${"3".repeat(64)}`;
const proposal = { id: "proposal1", researcherId: account, fundingTerms: { trancheBps: [5000, 5000] } };
const model = (overrides = {}) => ({ address: `0x${"b".repeat(40)}`, state: 0, decimals: 6, symbol: "USDC", selectionId,
  fundingTarget: 1000000000n, totalDeposited: 0n, totalReleased: 0n, outstandingBalance: 0n, remaining: 1000000000n,
  expiresAt: 2000000000n, approvalDeadline: 2000000000n, ownerApproved: false, solutionApproved: false,
  yesWeight: 0n, funderVoting: false, wallet: { balance: 2000000000n, contribution: 0n, depositor: { claimable: 0n }, hasVoted: false },
  roles: {}, can: { deposit: true }, currentMilestone: { evidenceHash: `0x${"0".repeat(64)}` }, ...overrides });
beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.account = { isConnected: true, address: account, chainId: 421614 }; mocks.user = { id: account };
  mocks.read.mockReset().mockResolvedValue(model()); mocks.write.mockReset().mockResolvedValue({ transactionHash: hash });
  mocks.confirm.mockReset().mockResolvedValue({ transactionHash: hash }); mocks.save.mockReset().mockResolvedValue({});
  mocks.load.mockReset().mockResolvedValue({ summary: "Delivery complete", url: "https://example.com/delivery", ownerId: account });
});
afterEach(cleanup);
const ready = async () => { render(<EscrowFundingPanel proposal={proposal} />); await screen.findByText("Open for funding"); };

describe("wallet escrow funding panel", () => {
  it("sends the exact decimal input only after a user action and refreshes after confirmation", async () => {
    await ready(); expect(mocks.write).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Contribution (USDC)"), { target: { value: "12.000001" } });
    fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ proposal, account, action: "deposit", amount: "12.000001" })));
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  });
  it.each(["disconnected", "wrong wallet", "wrong network"])("prevents signing with %s", async mode => {
    if (mode === "disconnected") mocks.account.isConnected = false;
    if (mode === "wrong wallet") mocks.account.address = `0x${"c".repeat(40)}`;
    if (mode === "wrong network") mocks.account.chainId = 1;
    await ready();
    expect(screen.getByRole("button", { name: "Fund escrow" }).disabled).toBe(true);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("requires evidence matching the on-chain hash before accepting delivery", async () => {
    mocks.read.mockResolvedValue(model({ state: 6, currentMilestone: { evidenceHash: hash }, roles: { problemOwner: true }, can: { approveMilestone: true } }));
    render(<EscrowFundingPanel proposal={proposal} />);
    await screen.findByText("Delivery in progress");
    expect(screen.getByRole("link", { name: "Review delivery evidence" }).getAttribute("href")).toBe("https://example.com/delivery");
    fireEvent.click(screen.getByRole("button", { name: "Accept as delivered" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ action: "approveMilestone", evidenceHash: hash, selectionId })));
  });
  it("disables approval of mismatched evidence without hiding available refunds", async () => {
    mocks.load.mockResolvedValue({ summary: "Different evidence", url: "https://example.com/other" });
    mocks.read.mockResolvedValue(model({ state: 6, currentMilestone: { evidenceHash: hash }, roles: { problemOwner: true },
      can: { approveMilestone: true, claimRefund: true }, wallet: { contribution: 10n, depositor: { claimable: 5n } } }));
    render(<EscrowFundingPanel proposal={proposal} />); await screen.findByText("Delivery in progress");
    expect(screen.getByRole("button", { name: "Accept as delivered" }).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Claim my refund" }).disabled).toBe(false);
    expect(screen.queryByRole("link", { name: "Review delivery evidence" })).toBeNull();
  });
  it("saves readable evidence before asking the wallet to submit its hash", async () => {
    const order = [];
    mocks.save.mockImplementation(async () => order.push("save")); mocks.write.mockImplementation(async () => order.push("write"));
    mocks.read.mockResolvedValue(model({ state: 6, roles: { proposalOwner: true }, can: { submitMilestone: true } }));
    render(<EscrowFundingPanel proposal={proposal} />); await screen.findByText("Delivery in progress");
    fireEvent.change(screen.getByLabelText("Delivery summary"), { target: { value: "Delivery complete" } });
    fireEvent.change(screen.getByLabelText("Evidence link (HTTPS)"), { target: { value: "https://example.com/delivery" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit delivery evidence" }));
    await waitFor(() => expect(order).toEqual(["save", "write"]));
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ action: "submitMilestone", evidenceHash: hash,
      evidence: { summary: "Delivery complete", url: "https://example.com/delivery" } }));
  });
  it("keeps funding disabled after an uncertain broadcast and retries only confirmation", async () => {
    mocks.write.mockRejectedValue(Object.assign(new Error("Receipt temporarily unavailable"), { transactionHash: hash }));
    await ready(); fireEvent.change(screen.getByLabelText("Contribution (USDC)"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
    const retry = await screen.findByRole("button", { name: "Retry confirmation" });
    expect(screen.getByRole("button", { name: "Fund escrow" }).disabled).toBe(true);
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(hash));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry confirmation" })).toBeNull());
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
  it("leaves refunds available when the evidence store is offline", async () => {
    mocks.load.mockRejectedValue(new Error("Offline"));
    mocks.read.mockResolvedValue(model({ state: 6, currentMilestone: { evidenceHash: hash }, can: { claimRefund: true } }));
    render(<EscrowFundingPanel proposal={proposal} />);
    expect(await screen.findByText(/Delivery evidence could not be loaded/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Claim my refund" }).disabled).toBe(false);
  });
  it("restores a broadcast after navigation and clears recovery only after confirmation", async () => {
    mocks.write.mockImplementation(async ({ onProgress }) => {
      onProgress({ status: "pending", action: "deposit", transactionHash: hash });
      throw Object.assign(new Error("Receipt temporarily unavailable"), { transactionHash: hash });
    });
    await ready(); fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
    await screen.findByRole("button", { name: "Retry confirmation" });
    cleanup(); await ready();
    expect(screen.getByRole("button", { name: "Fund escrow" }).disabled).toBe(true);
    expect(screen.getByRole("link", { name: "View pending transaction" }).getAttribute("href")).toContain(hash);
    fireEvent.click(screen.getByRole("button", { name: "Retry confirmation" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry confirmation" })).toBeNull());
    cleanup(); await ready();
    expect(screen.getByRole("button", { name: "Fund escrow" }).disabled).toBe(false);
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
  it("keeps refunds usable on moderated records while pausing funding", async () => {
    mocks.read.mockResolvedValue(model({ can: { deposit: true, claimRefund: true } }));
    render(<EscrowFundingPanel proposal={{ ...proposal, moderationStatus: "hidden" }} />);
    await screen.findByText("Open for funding");
    expect(screen.getByRole("button", { name: "Fund escrow" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Claim my refund" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ action: "claimRefund" })));
  });
  it.each([false, true])("renders final voting only for the chosen variant (voting=%s)", funderVoting => {
    render(<EscrowFundingView state={model({ state: 6, funderVoting, roles: { funder: true }, can: { voteMilestone: true }, currentMilestone: { evidenceHash: hash } })}
      evidence={{ hash, summary: "Delivery complete", url: "https://example.com/delivery" }} walletReady delivery={{ summary: "", url: "" }} />);
    expect(Boolean(screen.queryByRole("button", { name: "Vote yes" }))).toBe(funderVoting);
  });
});
