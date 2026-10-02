import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), confirm: vi.fn(), load: vi.fn(), save: vi.fn(), prepare: vi.fn(), sync: vi.fn(), history: vi.fn(), start: vi.fn(), account: null, user: null }));
vi.mock("../../src/lib/escrowFunding.js", async importOriginal => ({ ...await importOriginal(),
  prepareEscrowDeposit: (...args) => mocks.prepare(...args), syncEscrowFunding: (...args) => mocks.sync(...args),
  getEscrowFundingHistory: (...args) => mocks.history(...args), startEscrowSettlement: (...args) => mocks.start(...args) }));
vi.mock("wagmi", () => ({ useAccount: () => mocks.account }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../src/lib/escrow.js", () => ({ readEscrow: (...args) => mocks.read(...args), writeEscrowAction: (...args) => mocks.write(...args),
  confirmEscrowTransaction: (...args) => mocks.confirm(...args), escrowErrorMessage: error => error.message,
  hashEscrowEvidence: evidence => `0x${(evidence.summary === "Delivery complete" ? "1" : "2").repeat(64)}` }));
vi.mock("../../src/lib/escrowEvidence.js", () => ({ loadEscrowEvidence: (...args) => mocks.load(...args), saveEscrowEvidence: (...args) => mocks.save(...args) }));
vi.mock("../../src/components/ConnectWalletModal.jsx", () => ({ ConnectWalletModal: () => <p>Wallet connection dialog</p> }));
import { EscrowFundingPanel, EscrowFundingView } from "../../src/components/EscrowFundingPanel.jsx";
import { ACTION_ITEMS_KEY } from "../../src/lib/proposalQueues.js";
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
  mocks.account = { isConnected: true, address: account, chainId: 421614 }; mocks.user = { id: account, roles: ["funder", "owner"] };
  mocks.prepare.mockReset().mockResolvedValue({}); mocks.sync.mockReset().mockResolvedValue({ events: [] });
  mocks.history.mockReset().mockResolvedValue({ events: [] }); mocks.start.mockReset().mockResolvedValue({ events: [], settlement: { status: "confirmed" } });
  mocks.read.mockReset().mockResolvedValue(model()); mocks.write.mockReset().mockResolvedValue({ transactionHash: hash });
  mocks.confirm.mockReset().mockResolvedValue({ transactionHash: hash }); mocks.save.mockReset().mockResolvedValue({});
  mocks.load.mockReset().mockResolvedValue({ summary: "Delivery complete", url: "https://example.com/delivery", ownerId: account });
});
afterEach(cleanup);
const ready = async () => { render(<EscrowFundingPanel proposal={proposal} />); await screen.findByText("Open for funding"); };
function ActionCount({ read }) {
  const { data } = useQuery({ queryKey: [...ACTION_ITEMS_KEY, account], queryFn: read, staleTime: 60_000 });
  return <p>Verified action count: {data?.total ?? "loading"}</p>;
}

describe("wallet escrow funding panel", () => {
  it("refreshes an active action count after the owner confirms upfront approval", async () => {
    let total = 1;
    mocks.read.mockResolvedValue(model({ state: 1, roles: { problemOwner: true }, can: { approveSelection: true } }));
    mocks.write.mockImplementation(async () => { total = 0; return { transactionHash: hash }; });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    render(<QueryClientProvider client={client}><ActionCount read={async () => ({ total })} /><EscrowFundingPanel proposal={proposal} /></QueryClientProvider>);
    await screen.findByText("Verified action count: 1");
    fireEvent.click(await screen.findByRole("button", { name: "Approve upfront payment" }));
    await screen.findByText("Verified action count: 0");
    expect(mocks.write).toHaveBeenCalledTimes(1);
    client.clear();
  });
  it("shows grant acceptance status without pooled contribution controls before acceptance", () => {
    render(<EscrowFundingView state={model({ isGrant: true })} walletReady amount="" delivery={{ summary: "", url: "" }}
      fundingBlockReason="Sign in with a funder or problem owner account to deposit."
      settlement={{ status: "waiting", message: "The posting owner must select the fully funded proposal." }} />);
    expect(screen.getByText("Waiting for grant funding")).toBeTruthy();
    expect(screen.getByText("Grant funding moves into this escrow when the researcher accepts the selected offer.")).toBeTruthy();
    expect(screen.queryByLabelText("Contribution (USDC)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Fund escrow" })).toBeNull();
    expect(screen.queryByText(/posting owner must select/)).toBeNull();
    expect(screen.queryByText(/Sign in with a funder/)).toBeNull();
  });
  it("retains the grant owner's final delivery approval after grant acceptance", async () => {
    mocks.read.mockResolvedValue(model({ isGrant: true, state: 6, currentMilestone: { evidenceHash: hash },
      roles: { problemOwner: true }, can: { approveMilestone: true } }));
    render(<EscrowFundingPanel proposal={{ ...proposal, opportunityType: "open-funding" }} />);
    await screen.findByText("Delivery in progress");
    await screen.findByRole("link", { name: "Review delivery evidence" });
    const approve = screen.getByRole("button", { name: "Accept as delivered" });
    expect(approve.disabled).toBe(false); fireEvent.click(approve);
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ action: "approveMilestone", evidenceHash: hash })));
  });
  it("sends the exact decimal input only after a user action and refreshes after confirmation", async () => {
    await ready(); expect(mocks.write).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Contribution (USDC)"), { target: { value: "12.000001" } });
    fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ proposal, account, action: "deposit", amount: "12.000001" })));
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    expect(mocks.prepare).toHaveBeenCalledWith({ proposalId: proposal.id });
    expect(mocks.sync).toHaveBeenCalledWith({ proposalId: proposal.id, transactionHash: hash });
    expect(screen.getByText(/Deposit confirmed. Your tokens are held/)).toBeTruthy();
  });
  it("revalidates eligibility before requesting a deposit signature", async () => {
    mocks.prepare.mockRejectedValue(new Error("The posting has been closed."));
    await ready(); fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
    await screen.findByText("The posting has been closed.");
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("allows the problem owner to request selection through the platform service", async () => {
    mocks.read.mockResolvedValue(model({ remaining: 0n, roles: { problemOwner: true } }));
    await ready(); fireEvent.click(screen.getByRole("button", { name: "Select proposal for upfront approval" }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith({ proposalId: proposal.id }));
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each(["a sibling is selected", "the posting is paused"])("prevents selecting a fully funded proposal when %s", async reason => {
    mocks.read.mockResolvedValue(model({ remaining: 0n, workflowActive: false,
      workflowPaused: reason === "the posting is paused", roles: { problemOwner: true } }));
    await ready();
    const select = screen.getByRole("button", { name: "Select proposal for upfront approval" });
    expect(select.disabled).toBe(true);
    fireEvent.click(select);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("shows both on-chain handshake approvals and the actual deadline", async () => {
    mocks.read.mockResolvedValue(model({ state: 1, roles: { proposalOwner: true }, ownerApproved: true,
      can: { approveSelection: true }, supportsSelectionRejection: true }));
    render(<EscrowFundingPanel proposal={proposal} />);
    await screen.findByText("Awaiting upfront approval");
    expect(screen.getByText("Problem owner: approved. Proposal owner: pending.")).toBeTruthy();
    expect(screen.getByText(/Upfront approval time remaining/)).toBeTruthy();
    expect(screen.getByText(/Funding and selection are paused for every other proposal/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve upfront payment" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ action: "approveSelection", selectionId })));
  });
  it.each(["problemOwner", "proposalOwner"])("lets the %s reject the pending main selection with a reason", async role => {
    mocks.read.mockResolvedValue(model({ state: 1, roles: { [role]: true },
      supportsSelectionRejection: true, can: { approveSelection: true, rejectSelection: true } }));
    render(<EscrowFundingPanel proposal={proposal} />);
    await screen.findByText("Awaiting upfront approval");
    const reject = screen.getByRole("button", { name: "Reject selection and refund" });
    expect(reject.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason for rejecting selection"), { target: { value: "too short" } });
    fireEvent.click(reject);
    expect(mocks.write).not.toHaveBeenCalled();
    const reason = "The revised project scope cannot be delivered.";
    fireEvent.change(screen.getByLabelText("Reason for rejecting selection"), { target: { value: reason } });
    expect(reject.disabled).toBe(false);
    fireEvent.click(reject);
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ action: "rejectSelection", selectionId, reason })));
    expect(mocks.sync).toHaveBeenCalledWith({ proposalId: proposal.id, transactionHash: hash });
    expect(await screen.findByText(/Selection rejected. This proposal’s full contribution balance is refundable/)).toBeTruthy();
  });
  it("opens expired pending-selection refunds without allowing late approval or rejection", async () => {
    mocks.read.mockResolvedValue(model({ state: 1, roles: { problemOwner: true }, supportsSelectionRejection: true,
      can: { expire: true, approveSelection: false, rejectSelection: false } }));
    render(<EscrowFundingPanel proposal={proposal} />);
    await screen.findByText("Awaiting upfront approval");
    expect(screen.getByRole("button", { name: "Approve upfront payment" }).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Reject selection and refund" })).toBeNull();
    expect(screen.getByText(/full contribution balance is refundable after rejection or expiry/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open expired escrow refunds" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ action: "expire" })));
  });
  it("explains a pending sibling lock and keeps grants outside the main rejection controls", () => {
    const { rerender } = render(<EscrowFundingView state={model({ blockedBySelection: true, workflowActive: false })}
      walletReady amount="" delivery={{ summary: "", url: "" }} />);
    expect(screen.getByText(/another proposal awaits both owners’ approval/)).toBeTruthy();
    rerender(<EscrowFundingView state={model({ state: 1, isGrant: true, supportsSelectionRejection: true,
      roles: { problemOwner: true }, can: { rejectSelection: true } })} walletReady amount="" delivery={{ summary: "", url: "" }} />);
    expect(screen.queryByLabelText("Reason for rejecting selection")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject selection and refund" })).toBeNull();
    expect(screen.queryByText(/Upfront approval time remaining/)).toBeNull();
  });
  it("keeps successful wallet payment separate from an indexing failure", async () => {
    mocks.sync.mockRejectedValue(new Error("Service unavailable"));
    await ready(); fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
    await screen.findByText(/wallet transaction confirmed, but funding records/);
    expect(screen.getByText(/Deposit confirmed. Your tokens are held/)).toBeTruthy();
    expect(mocks.write).toHaveBeenCalledTimes(1);
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
  it("keeps historical balances and refunds visible without mixing the current funding index", async () => {
    mocks.read.mockResolvedValue(model({ isHistorical: true, can: { deposit: false, claimRefund: true } }));
    await ready();
    expect(screen.getByText(/belongs to an earlier contract deployment/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fund escrow" }).disabled).toBe(true);
    expect(screen.queryByRole("heading", { name: "Funding audit trail" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Claim my refund" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ action: "claimRefund" })));
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it.each([false, true])("renders final voting only for the chosen variant (voting=%s)", funderVoting => {
    render(<EscrowFundingView state={model({ state: 6, funderVoting, roles: { funder: true }, can: { voteMilestone: true }, currentMilestone: { evidenceHash: hash } })}
      evidence={{ hash, summary: "Delivery complete", url: "https://example.com/delivery" }} walletReady delivery={{ summary: "", url: "" }} />);
    expect(Boolean(screen.queryByRole("button", { name: "Vote yes" }))).toBe(funderVoting);
  });
});
