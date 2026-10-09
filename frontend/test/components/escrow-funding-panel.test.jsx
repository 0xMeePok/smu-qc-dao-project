import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
const live = vi.hoisted(() => ({ options: null }));
vi.mock("../../src/hooks/useLiveActivity.js", () => ({ useLiveActivity: options => { live.options = options; } }));
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
import { AUDIT_REGISTRY_CONFIG } from "../../src/config/auditRegistry.js";
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
afterEach(() => { cleanup(); vi.useRealTimers(); });
const ready = async () => { render(<EscrowFundingPanel proposal={proposal} />); await screen.findByText("Open for funding"); };
function ActionCount({ read }) {
  const { data } = useQuery({ queryKey: [...ACTION_ITEMS_KEY, account], queryFn: read, staleTime: 60_000 });
  return <p>Verified action count: {data?.total ?? "loading"}</p>;
}

describe("wallet escrow funding panel", () => {
  it("refreshes an active action count after the owner confirms upfront approval", async () => {
    const confirmed = vi.fn();
    let total = 1;
    mocks.read.mockResolvedValue(model({ state: 1, roles: { problemOwner: true }, can: { approveSelection: true } }));
    mocks.write.mockImplementation(async () => { total = 0; return { transactionHash: hash }; });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    render(<QueryClientProvider client={client}><ActionCount read={async () => ({ total })} /><EscrowFundingPanel proposal={proposal} onConfirmed={confirmed} /></QueryClientProvider>);
    await screen.findByText("Verified action count: 1");
    fireEvent.click(await screen.findByRole("button", { name: "Approve upfront payment" }));
    await screen.findByText("Verified action count: 0");
    expect(confirmed).toHaveBeenCalledTimes(1);
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
    fireEvent.change(screen.getByLabelText("Contribution (USDC)"), { target: { value: "12.01" } });
    fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ proposal, account, action: "deposit", amount: "12.01" })));
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    expect(mocks.prepare).toHaveBeenCalledWith({ proposalId: proposal.id, amount: "12.01" });
    expect(mocks.sync).toHaveBeenCalledWith({ proposalId: proposal.id, transactionHash: hash });
    expect(screen.getByText(/Deposit confirmed. Your tokens are held/)).toBeTruthy();
  });
  it("revalidates eligibility before requesting a deposit signature", async () => {
    mocks.prepare.mockRejectedValue(new Error("The posting has been closed."));
    await ready();
    fireEvent.change(screen.getByLabelText("Contribution (USDC)"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
    await screen.findByText("The posting has been closed.");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(screen.queryByText("Checking current funding status and network fees…")).toBeNull();
  });
  it("shows preparation while deposit eligibility is checked without asking for a wallet prompt yet", async () => {
    mocks.prepare.mockImplementation(() => new Promise(() => {}));
    await ready();
    fireEvent.change(screen.getByLabelText("Contribution (USDC)"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
    expect(screen.getByText("Checking current funding status and network fees…")).toBeTruthy();
    expect(screen.queryByText(/confirm the escrow deposit in your wallet/)).toBeNull();
    expect(screen.queryByText("Transaction confirmed.")).toBeNull();
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
    await ready();
    fireEvent.change(screen.getByLabelText("Contribution (USDC)"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
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
    await ready();
    fireEvent.change(screen.getByLabelText("Contribution (USDC)"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
    await screen.findByRole("button", { name: "Retry confirmation" });
    cleanup(); await ready();
    expect(screen.getByRole("button", { name: "Fund escrow" }).disabled).toBe(true);
    expect(screen.getByRole("link", { name: "View pending transaction" }).getAttribute("href")).toContain(hash);
    fireEvent.click(screen.getByRole("button", { name: "Retry confirmation" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry confirmation" })).toBeNull());
    cleanup(); await ready();
    fireEvent.change(screen.getByLabelText("Contribution (USDC)"), { target: { value: "1" } });
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

it("refreshes stored dashboard and payment summaries only after confirmed funding is synchronized", async () => {
  const client = new QueryClient();
  const keys = [["funderDashboard", account], ["escrowFundingSummary", account]];
  for (const key of keys) client.setQueryData(key, { amount: "old" });
  let synchronize;
  mocks.sync.mockImplementationOnce(() => new Promise(resolve => { synchronize = resolve; }));
  render(<QueryClientProvider client={client}><EscrowFundingPanel proposal={proposal} /></QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText("Contribution (USDC)"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
  await waitFor(() => expect(synchronize).toBeTypeOf("function"));
  for (const key of keys) expect(client.getQueryState(key).isInvalidated).toBe(false);
  synchronize({ events: [] });
  await waitFor(() => { for (const key of keys) expect(client.getQueryState(key).isInvalidated).toBe(true); });
  client.clear();
});

it("blocks funding after an audit mismatch while keeping verified refund recovery and refresh available", async () => {
  mocks.read.mockResolvedValue(model({ can: { deposit: true, claimRefund: true } }));
  render(<EscrowFundingPanel proposal={proposal} integrityBlocked />);
  const fund = await screen.findByRole("button", { name: "Fund escrow" });
  expect(fund.disabled).toBe(true);
  fireEvent.click(fund);
  expect(mocks.write).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Refresh escrow" }).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Claim my refund" }));
  await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ action: "claimRefund" })));
});

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

it("shows independently verified balances while history and evidence are still loading", async () => {
  const records = deferred(), evidence = deferred();
  mocks.history.mockReturnValue(records.promise); mocks.load.mockReturnValue(evidence.promise);
  mocks.read.mockResolvedValue(model({ state: 6, currentMilestone: { evidenceHash: hash },
    roles: { problemOwner: true }, can: { approveMilestone: true, claimRefund: true } }));
  render(<EscrowFundingPanel proposal={proposal} />);
  await screen.findByText("Delivery in progress");
  expect(screen.queryByText("Reading the verified escrow…")).toBeNull();
  expect(screen.getByRole("button", { name: "Claim my refund" }).disabled).toBe(false);
  expect(screen.getByRole("button", { name: "Accept as delivered" }).disabled).toBe(true);
  await act(async () => { evidence.resolve({ summary: "Delivery complete", url: "https://example.com/delivery" }); });
  expect(screen.getByRole("button", { name: "Accept as delivered" }).disabled).toBe(false);
  await act(async () => { records.resolve({ events: [] }); });
});

it("refreshes confirmed wallet balances before a slow reconciliation finishes", async () => {
  const synced = deferred(); mocks.sync.mockReturnValue(synced.promise);
  await ready();
  mocks.read.mockResolvedValue(model({ state: 6, totalReleased: 500000000n, can: {} }));
  fireEvent.change(screen.getByLabelText("Contribution (USDC)"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
  await screen.findByText("Delivery in progress");
  expect(screen.getByText("500 USDC")).toBeTruthy();
  expect(screen.getByText(/Your transaction is confirmed. Updating funding records/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Refresh escrow" }).disabled).toBe(true);
  expect(mocks.history).toHaveBeenCalledTimes(1);
  await act(async () => { synced.resolve({ events: [] }); });
  expect(screen.getByRole("button", { name: "Refresh escrow" }).disabled).toBe(false);
});

it("follows the separate platform payout receipt and updates released funds without waiting for polling", async () => {
  const receipt = deferred(), paymentHash = `0x${"f".repeat(64)}`;
  mocks.read.mockResolvedValue(model({ state: 1, roles: { problemOwner: true }, can: { approveSelection: true } }));
  mocks.sync.mockResolvedValueOnce({ events: [], settlement: { status: "pending", transactionHash: paymentHash } })
    .mockResolvedValueOnce({ events: [], settlement: { status: "waiting", message: "Delivery evidence required." } });
  mocks.confirm.mockReturnValue(receipt.promise);
  render(<EscrowFundingPanel proposal={proposal} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve upfront payment" }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(paymentHash));
  expect(screen.getByText(/platform action is awaiting confirmation/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Approve upfront payment" }).disabled).toBe(true);
  mocks.read.mockResolvedValue(model({ state: 6, totalReleased: 500000000n, can: {} }));
  await act(async () => { receipt.resolve({ transactionHash: paymentHash }); });
  await screen.findByText("Delivery in progress");
  expect(screen.getByText("500 USDC")).toBeTruthy();
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  expect(mocks.sync).toHaveBeenLastCalledWith({ proposalId: proposal.id });
  expect(mocks.write).toHaveBeenCalledTimes(1);
  expect(mocks.history).toHaveBeenCalledTimes(1);
});

it("keeps a delayed platform receipt separate from the confirmed wallet payment and retries without a wallet write", async () => {
  const paymentHash = `0x${"f".repeat(64)}`;
  mocks.sync.mockResolvedValue({ events: [], settlement: { status: "pending", transactionHash: paymentHash } });
  mocks.confirm.mockRejectedValueOnce(new Error("Receipt temporarily unavailable"));
  await ready();
    fireEvent.change(screen.getByLabelText("Contribution (USDC)"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
  await screen.findByText(/wallet transaction confirmed, but funding records/);
  expect(screen.queryByRole("button", { name: "Retry confirmation" })).toBeNull();
  expect(screen.getByText(/Deposit confirmed. Your tokens are held/)).toBeTruthy();
  mocks.sync.mockResolvedValue({ events: [], settlement: { status: "complete" } });
  fireEvent.click(screen.getByRole("button", { name: "Retry payment status" }));
  await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
  expect(mocks.write).toHaveBeenCalledTimes(1);
});

it("uses the existing interval to recover queued settlement without overlapping a pending request", async () => {
  vi.useFakeTimers();
  const synced = deferred();
  mocks.history.mockResolvedValue({ events: [], settlement: { status: "queued", message: "Payment queued." } });
  mocks.sync.mockReturnValue(synced.promise);
  render(<EscrowFundingPanel proposal={proposal} />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  await act(async () => { synced.resolve({ events: [], settlement: { status: "complete" } }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(mocks.sync).toHaveBeenCalledTimes(1);
});

it("does not apply stale evidence after switching proposals", async () => {
  const previous = deferred();
  mocks.read.mockResolvedValue(model({ state: 6, currentMilestone: { evidenceHash: hash }, roles: { problemOwner: true }, can: { approveMilestone: true } }));
  mocks.load.mockReturnValueOnce(previous.promise).mockResolvedValueOnce(null);
  const view = render(<EscrowFundingPanel proposal={proposal} />);
  await screen.findByText("Delivery in progress");
  view.rerender(<EscrowFundingPanel proposal={{ ...proposal, id: "proposal2" }} />);
  await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
  await act(async () => { previous.resolve({ summary: "Delivery complete", url: "https://example.com/old" }); });
  expect(screen.queryByRole("link", { name: "Review delivery evidence" })).toBeNull();
  expect(screen.getByRole("button", { name: "Accept as delivered" }).disabled).toBe(true);
});

it("follows a platform selection receipt immediately without a wallet signature", async () => {
  const receipt = deferred(), selectionHash = `0x${"e".repeat(64)}`;
  mocks.read.mockResolvedValue(model({ remaining: 0n, roles: { problemOwner: true } }));
  mocks.start.mockResolvedValue({ events: [], settlement: { status: "pending", transactionHash: selectionHash } });
  mocks.confirm.mockReturnValue(receipt.promise);
  await ready(); fireEvent.click(screen.getByRole("button", { name: "Select proposal for upfront approval" }));
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(selectionHash));
  expect(screen.getByText(/The platform action is awaiting confirmation/)).toBeTruthy();
  mocks.read.mockResolvedValue(model({ state: 1, roles: { problemOwner: true }, can: { approveSelection: true } }));
  await act(async () => { receipt.resolve({ transactionHash: selectionHash }); });
  await screen.findByText("Awaiting upfront approval");
  expect(mocks.start).toHaveBeenCalledTimes(1);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  expect(mocks.write).not.toHaveBeenCalled();
});

it("does not let a delayed transaction refresh or synchronize a newly opened proposal", async () => {
  const written = deferred(); mocks.write.mockReturnValue(written.promise);
  const view = render(<EscrowFundingPanel proposal={proposal} />);
  fireEvent.change(await screen.findByLabelText("Contribution (USDC)"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
  await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1));
  view.rerender(<EscrowFundingPanel proposal={{ ...proposal, id: "proposal2" }} />);
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  await act(async () => { written.resolve({ transactionHash: hash }); });
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/Deposit confirmed/)).toBeNull();
});

it("stops before asking the wallet when navigation occurs during deposit preparation", async () => {
  const prepared = deferred(); mocks.prepare.mockReturnValue(prepared.promise);
  const view = render(<EscrowFundingPanel proposal={proposal} />);
  fireEvent.change(await screen.findByLabelText("Contribution (USDC)"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
  await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(1));
  view.rerender(<EscrowFundingPanel proposal={{ ...proposal, id: "proposal2" }} />);
  await act(async () => { prepared.resolve({}); });
  expect(mocks.write).not.toHaveBeenCalled();
});

it("retains an original proposal's uncertain broadcast when navigation happens during the wallet request", async () => {
  const written = deferred(); let progress;
  mocks.write.mockImplementation(({ onProgress }) => { progress = onProgress; return written.promise; });
  const view = render(<EscrowFundingPanel proposal={proposal} />);
  fireEvent.change(await screen.findByLabelText("Contribution (USDC)"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
  await waitFor(() => expect(progress).toBeTypeOf("function"));
  view.rerender(<EscrowFundingPanel proposal={{ ...proposal, id: "proposal2" }} />);
  await act(async () => {
    progress({ status: "pending", action: "deposit", transactionHash: hash });
    written.reject(Object.assign(new Error("Receipt unavailable"), { transactionHash: hash }));
  });
  expect(screen.queryByRole("button", { name: "Retry confirmation" })).toBeNull();
  expect(screen.queryByText("Receipt unavailable")).toBeNull();
  view.rerender(<EscrowFundingPanel proposal={proposal} />);
  await screen.findByRole("button", { name: "Retry confirmation" });
  expect(screen.getByRole("link", { name: "View pending transaction" }).getAttribute("href")).toContain(hash);
});

it("blocks overfunding inline before preparation or wallet approval and accepts the exact remaining amount", async () => {
  mocks.read.mockResolvedValue(model({ totalDeposited: 980000000n, remaining: 20000000n }));
  await ready();
  const input = screen.getByLabelText("Contribution (USDC)");
  fireEvent.change(input, { target: { value: "20.000001" } });
  expect(screen.getByRole("alert").textContent).toBe("Only 20 USDC is still needed. Enter 20 USDC or less.");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.getAttribute("aria-describedby")).toContain("escrow-contribution-error");
  const fund = screen.getByRole("button", { name: "Fund escrow", exact: true });
  expect(fund.disabled).toBe(true);
  fireEvent.click(fund);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "20" } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(fund.disabled).toBe(false);
});

it("keeps invalid precision, tiny partial amounts and dusty remainders out of the wallet", async () => {
  mocks.read.mockResolvedValue(model({ totalDeposited: 980000000n, remaining: 20000000n }));
  await ready();
  const input = screen.getByLabelText("Contribution (USDC)");
  const fund = screen.getByRole("button", { name: "Fund escrow", exact: true });
  for (const [amount, message] of [["1.001", /2 decimal places/], ["0.99", /at least 1/], ["19.01", /would leave only 0.99/]]) {
    fireEvent.change(input, { target: { value: amount } });
    expect(screen.getByRole("alert").textContent).toMatch(message);
    expect(fund.disabled).toBe(true);
    fireEvent.click(fund);
  }
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "19" } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(fund.disabled).toBe(false);
});


it("refreshes verified balances and history on live activity without clearing contribution input", async () => {
  const confirmed = vi.fn();
  render(<EscrowFundingPanel proposal={proposal} onConfirmed={confirmed} />);
  await screen.findByText("Open for funding");
  fireEvent.change(screen.getByLabelText("Contribution (USDC)"), { target: { value: "25" } });
  mocks.read.mockResolvedValue(model({ totalDeposited: 25000000n, remaining: 975000000n }));
  await act(async () => { await live.options.onRefresh(); });
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(mocks.history).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText("Contribution (USDC)").value).toBe("25");
  expect(live.options).toMatchObject({ proposalId: proposal.id, identity: account, channel: "funding", blocked: false });
  expect(mocks.write).not.toHaveBeenCalled();
  expect(confirmed).not.toHaveBeenCalled();
});

const coveredSummary = (overrides = {}) => ({ proposalId: proposal.id, chainId: AUDIT_REGISTRY_CONFIG.chainId,
  registryAddress: AUDIT_REGISTRY_CONFIG.address, escrowAddress: model().address, blockNumber: 100,
  verified: true, ...overrides });
const blockModel = (overrides = {}) => model({ chainId: AUDIT_REGISTRY_CONFIG.chainId, blockNumber: 100n, ...overrides });
it("coalesces a payment activity echo already covered by the freshly verified block while updating history", async () => {
  mocks.read.mockResolvedValue(blockModel());
  await ready();
  fireEvent.change(screen.getByLabelText("Contribution (USDC)"), { target: { value: "25" } });
  fireEvent.click(screen.getByRole("button", { name: "Fund escrow" }));
  await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh escrow" }).disabled).toBe(false));
  expect(mocks.read).toHaveBeenCalledTimes(2);
  mocks.history.mockResolvedValue({ events: [], summary: coveredSummary() });
  await act(async () => { await live.options.onRefresh({ activityOnly: true, activitySnapshots: [coveredSummary()] }); });
  expect(mocks.history).toHaveBeenCalledTimes(2);
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(mocks.write).toHaveBeenCalledTimes(1);
  // Focus/fallback/manual reads are never suppressed by a recent snapshot.
  await act(async () => { await live.options.onRefresh({ activityOnly: false }); });
  expect(mocks.read).toHaveBeenCalledTimes(3);
});
it.each([
  ["newer block", coveredSummary({ blockNumber: 101 })],
  ["missing summary", null],
  ["unverified snapshot", coveredSummary({ verified: false })],
  ["different proposal", coveredSummary({ proposalId: "other" })],
  ["different deployment", coveredSummary({ registryAddress: `0x${"f".repeat(40)}` })],
  ["different escrow", coveredSummary({ escrowAddress: `0x${"f".repeat(40)}` })],
  ["different chain", coveredSummary({ chainId: 1 })],
  ["malformed block", coveredSummary({ blockNumber: "100" })],
])("keeps a fresh chain read for activity with %s", async (_label, summary) => {
  mocks.read.mockResolvedValue(blockModel()); await ready();
  mocks.history.mockResolvedValue({ events: [] });
  await act(async () => { await live.options.onRefresh({ activityOnly: true, activitySnapshots: [summary] }); });
  expect(mocks.read).toHaveBeenCalledTimes(2);
});
it("never treats an aged or historical snapshot as covering new activity", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(10000);
  try {
    mocks.read.mockResolvedValue(blockModel()); await ready();
    mocks.history.mockResolvedValue({ events: [], summary: coveredSummary() });
    now.mockReturnValue(15001);
    await act(async () => { await live.options.onRefresh({ activityOnly: true, activitySnapshots: [coveredSummary()] }); });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    mocks.read.mockResolvedValue(blockModel({ isHistorical: true }));
    await act(async () => { await live.options.onRefresh(); });
    await act(async () => { await live.options.onRefresh({ activityOnly: true, activitySnapshots: [coveredSummary()] }); });
    expect(mocks.read).toHaveBeenCalledTimes(4);
  } finally { now.mockRestore(); }
});
it("keeps independent chain verification when an unversioned signal has a history error", async () => {
  mocks.read.mockResolvedValue(blockModel()); await ready();
  mocks.history.mockRejectedValue(new Error("History unavailable"));
  await act(async () => { await live.options.onRefresh({ activityOnly: true, activitySnapshots: [null] }); });
  expect(mocks.read).toHaveBeenCalledTimes(2);
});

it("preserves a pending evidence read across a covered activity echo", async () => {
  const evidence = deferred(); mocks.load.mockReturnValue(evidence.promise);
  mocks.read.mockResolvedValue(blockModel({ state: 6, currentTranche: 1, roles: { problemOwner: true },
    currentMilestone: { evidenceHash: hash }, can: { approveMilestone: true } }));
  render(<EscrowFundingPanel proposal={proposal} />);
  await screen.findByText("Delivery in progress");
  expect(screen.getByRole("button", { name: "Accept as delivered" }).disabled).toBe(true);
  await act(async () => { await live.options.onRefresh({ activityOnly: true, activitySnapshots: [coveredSummary()] }); });
  expect(mocks.read).toHaveBeenCalledTimes(1); expect(mocks.load).toHaveBeenCalledTimes(1);
  await act(async () => { evidence.resolve({ summary: "Delivery complete", url: "https://example.com/delivery" }); });
  expect(screen.getByRole("button", { name: "Accept as delivered" }).disabled).toBe(false);
});
it("does not let delayed history hold up a covered activity echo", async () => {
  mocks.read.mockResolvedValue(blockModel()); await ready();
  const history = deferred(); mocks.history.mockReturnValue(history.promise);
  await act(async () => { await live.options.onRefresh({ activityOnly: true, activitySnapshots: [coveredSummary()] }); });
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Refresh escrow" }).disabled).toBe(false);
  await act(async () => { history.resolve({ events: [] }); });
});
