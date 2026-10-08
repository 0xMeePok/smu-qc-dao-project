import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), sync: vi.fn(), confirm: vi.fn(),
  user: { id: `0x${"a".repeat(40)}` }, account: { address: `0x${"a".repeat(40)}`, isConnected: true, chainId: 421614 } }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("wagmi", async importOriginal => ({ ...await importOriginal(), useAccount: () => mocks.account }));
vi.mock("../../src/lib/independentEscrow.js", async importOriginal => ({ ...await importOriginal(),
  getIndependentFundingState: (...args) => mocks.read(...args), writeIndependentFundingAction: (...args) => mocks.write(...args),
  syncIndependentFunding: (...args) => mocks.sync(...args) }));
vi.mock("../../src/lib/escrow.js", async importOriginal => ({ ...await importOriginal(), confirmEscrowTransaction: (...args) => mocks.confirm(...args) }));
import { IndependentFundingPanel, IndependentFundingView } from "../../src/components/IndependentFundingPanel.jsx";
afterEach(cleanup);
const summary = { state: "Open", escrowAddress: `0x${"b".repeat(40)}`, tokenSymbol: "USDT", tokenDecimals: 6,
  fundingTarget: "2000000", totalDeposited: "1000000", totalReleased: "0", feePaid: "0", outstandingBalance: "1000000",
  expiresAt: "2000000000", completionDeadline: "0", yesWeight: "0" };
const props = extra => ({ snapshot: { exists: true, configured: true, summary, wallet: { deposited: "1000000", claimable: "0" }, actions: { deposit: true } },
  walletReady: true, amount: "1", onAmount: vi.fn(), delivery: { summary: "", url: "" }, onDelivery: vi.fn(), onAction: vi.fn(), onRefresh: vi.fn(), ...extra });
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); mocks.user = { id: `0x${"a".repeat(40)}` };
  mocks.account = { address: mocks.user.id, isConnected: true, chainId: 421614 }; mocks.read.mockReset().mockResolvedValue(props().snapshot);
  mocks.sync.mockResolvedValue({}); mocks.confirm.mockResolvedValue({ transactionHash: `0x${"1".repeat(64)}` }); });

it("lets funders contribute without any problem-owner selection or dual-approval controls", () => {
  const p = props(); render(<IndependentFundingView {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Fund independent listing" }));
  expect(p.onAction).toHaveBeenCalledWith("deposit", { amount: "1" });
  expect(screen.queryByText(/problem owner/i)).toBeNull();
  expect(screen.queryByRole("button", { name: "Approve upfront payment" })).toBeNull();
  expect(screen.getByText(/Refunds have no additional platform fee/)).toBeTruthy();
});
it("shows researcher acceptance at a full target and explicitly releases 50% immediately", () => {
  const p = props({ snapshot: { exists: true, summary: { ...summary, totalDeposited: "2000000" },
    wallet: {}, actions: { accept: true, decline: true } }, reason: "Delivery scope has changed", onReason: vi.fn() });
  render(<IndependentFundingView {...p} />);
  expect(screen.getByText("Target reached")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Accept funding and release 50%" }));
  expect(p.onAction).toHaveBeenCalledWith("accept", {});
  fireEvent.click(screen.getByRole("button", { name: "Decline funding and enable refunds" }));
  expect(p.onAction).toHaveBeenCalledWith("decline", { reason: "Delivery scope has changed" });
  expect(screen.queryByRole("button", { name: "Fund independent listing" })).toBeNull();
});
it("explains unavailable listing actions while keeping its available refund actionable", () => {
  const p = props({ snapshot: { exists: true, hidden: true, summary: { ...summary, state: "Cancelled" },
    wallet: { deposited: "1000000", claimable: "1000000" }, actions: { claimRefund: true } } });
  render(<IndependentFundingView {...p} />);
  expect(screen.getByText(/funding actions are unavailable/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Claim my refund" }));
  expect(p.onAction).toHaveBeenCalledWith("claimRefund", {});
});
it("explains weighted majority completion and binds voting to the displayed evidence", () => {
  const hash = `0x${"2".repeat(64)}`;
  const p = props({ snapshot: { exists: true, summary: { ...summary, state: "Accepted", totalDeposited: "2000000",
    totalReleased: "1000000", completionDeadline: "2002592000", evidenceHash: hash, yesWeight: "1000000" },
    evidence: { hash, summary: "Delivered prototype", url: "https://example.com/prototype" }, wallet: {}, actions: { vote: true } } });
  render(<IndependentFundingView {...p} />);
  expect(screen.getByRole("link", { name: "Open delivery evidence" }).href).toBe("https://example.com/prototype");
  expect(screen.getByText(/yes vote that takes approval above 50% releases/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Vote yes for completion" }));
  expect(p.onAction).toHaveBeenCalledWith("vote", { evidenceHash: hash, approve: true });
  expect(screen.queryByRole("button", { name: "Release final 50%" })).toBeNull();
});
it("shows the final payout and exact researcher net after the majority vote releases it", () => {
  render(<IndependentFundingView {...props({ snapshot: { exists: true, summary: { ...summary, state: "Released",
    totalDeposited: "2000000", totalReleased: "2000000", feePaid: "2000", outstandingBalance: "0" }, wallet: {}, actions: {} } })} />);
  expect(screen.getByText("Fully paid")).toBeTruthy();
  expect(screen.getByText("Researcher received after fees").nextSibling.textContent).toBe("1.998 USDT");
  expect(screen.queryByRole("button", { name: "Vote yes for completion" })).toBeNull();
});
it("allows a direct pull refund after expiry without an extra expiry transaction", () => {
  const p = props({ snapshot: { exists: true, summary: { ...summary, state: "Expired" },
    wallet: { deposited: "1000000", claimable: "1000000" }, actions: { claimRefund: true, expire: true } } });
  render(<IndependentFundingView {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Claim my refund" }));
  expect(p.onAction).toHaveBeenCalledWith("claimRefund", {});
  expect(screen.queryByRole("button", { name: "Enable expired funding refunds" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Fund independent listing" })).toBeNull();
});
it("offers activation for an existing listing and blocks new actions while a transaction is pending", () => {
  const confirm = vi.fn(); render(<IndependentFundingView {...props({ snapshot: { configured: true, exists: false, actions: { activate: true } },
    unresolved: { transactionHash: `0x${"1".repeat(64)}` }, onConfirm: confirm })} />);
  expect(screen.getByRole("button", { name: "Activate crowdfunding" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry confirmation" })); expect(confirm).toHaveBeenCalledOnce();
});

it("ignores an old account's delayed read after the connected account changes", async () => {
  let resolveOld, resolveNew;
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const changed = vi.fn(), view = render(<IndependentFundingPanel proposal={{ id: "switching-wallet" }} onStateChange={changed} />);
  mocks.user = { id: `0x${"c".repeat(40)}` }; mocks.account = { ...mocks.account, address: mocks.user.id };
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
  view.rerender(<IndependentFundingPanel proposal={{ id: "switching-wallet" }} onStateChange={changed} />);
  const current = { ...props().snapshot, summary: { ...summary, totalDeposited: "3000000", fundingTarget: "4000000" } };
  await act(async () => resolveNew(current));
  expect(screen.getByText("Funded / target").nextSibling.textContent).toBe("3 USDT / 4 USDT");
  await act(async () => resolveOld(props().snapshot));
  expect(screen.getByText("Funded / target").nextSibling.textContent).toBe("3 USDT / 4 USDT");
  expect(changed).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledWith(current);
});

it("retries confirmation of an existing activation hash without requesting a new signature", async () => {
  const transactionHash = `0x${"1".repeat(64)}`;
  const client = new QueryClient();
  const wallet = mocks.user.id;
  for (const name of ["funderDashboard", "escrowFundingSummary"]) client.setQueryData([name, wallet], {});
  render(<QueryClientProvider client={client}><IndependentFundingPanel proposal={{ id: "pending-activation" }} initialTransaction={{ transactionHash, action: "activate" }} /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Retry confirmation" }));
  await screen.findByText("Crowdfunding transaction confirmed.");
  expect(mocks.confirm).toHaveBeenCalledWith(transactionHash);
  expect(mocks.sync).toHaveBeenCalledWith({ proposalId: "pending-activation", transactionHash });
  for (const name of ["funderDashboard", "escrowFundingSummary"]) expect(client.getQueryState([name, wallet]).isInvalidated).toBe(true);
  client.clear();
  expect(mocks.write).not.toHaveBeenCalled();
});

it("removes stale independent funding actions when refreshed verification fails", async () => {
  const changed = vi.fn();
  mocks.read.mockResolvedValue(props().snapshot);
  render(<IndependentFundingPanel proposal={{ id: "mismatch-check" }} onStateChange={changed} />);
  await screen.findByRole("button", { name: "Fund independent listing" });
  mocks.read.mockRejectedValueOnce(new Error("Mismatch detected in the listing."));
  fireEvent.click(screen.getByRole("button", { name: "Refresh crowdfunding" }));
  await screen.findByText("Mismatch detected in the listing.");
  expect(screen.queryByRole("button", { name: "Fund independent listing" })).toBeNull();
  expect(changed).toHaveBeenLastCalledWith(null);
});

it("blocks new independent deposits on a page integrity mismatch without blocking available pull refunds", () => {
  const p = props({ integrityBlocked: true, snapshot: { ...props().snapshot, actions: { deposit: true, claimRefund: true } } });
  render(<IndependentFundingView {...p} />);
  expect(screen.getByRole("button", { name: "Fund independent listing" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Fund independent listing" }));
  expect(p.onAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Claim my refund" }));
  expect(p.onAction).toHaveBeenCalledWith("claimRefund", {});
});
