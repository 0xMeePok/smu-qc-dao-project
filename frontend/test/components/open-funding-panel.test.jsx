import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
const live = vi.hoisted(() => ({ options: null }));
vi.mock("../../src/hooks/useLiveActivity.js", () => ({ useLiveActivity: options => { live.options = options; } }));
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), sync: vi.fn(), confirm: vi.fn(), readContract: vi.fn(), supported: true, account: null, user: null, signIn: vi.fn() }));
vi.mock("../../src/context/WalletContext.jsx", () => ({ useWallet: () => mocks.account }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../src/context/SessionContext.jsx", () => ({ useSignIn: () => mocks.signIn }));
vi.mock("../../src/lib/openFunding.js", () => ({ getOpenFundingSummary: (...args) => mocks.read(...args),
  writeOpenFundingAction: (...args) => mocks.write(...args), syncOpenFunding: (...args) => mocks.sync(...args), openFundingSupported: () => mocks.supported }));
vi.mock("../../src/lib/escrow.js", () => ({ confirmEscrowTransaction: (...args) => mocks.confirm(...args),
  createWalletEscrowAdapters: () => ({ readContract: (...args) => mocks.readContract(...args) }), escrowErrorMessage: error => error.message }));
import { OpenFundingPanel, OpenFundingView } from "../../src/components/OpenFundingPanel.jsx";
import { ACTION_ITEMS_KEY } from "../../src/lib/proposalQueues.js";
const account = `0x${"a".repeat(40)}`, hash = `0x${"1".repeat(64)}`;
const proposal = { proposalId: "solution", title: "Quantum solution", amountBaseUnits: "50000000000", status: "none", canSelect: true };
const model = (extra = {}) => ({ supported: true, chainId: 421614, poolAddress: `0x${"b".repeat(40)}`, tokenAddress: `0x${"c".repeat(40)}`,
  tokenDecimals: 6, tokenSymbol: "USDC", totalDeposited: "100000000000", totalAllocated: "0", totalReserved: "0", available: "100000000000",
  canDeposit: true, canSelect: true, selections: [proposal], ...extra });
function ActionCount({ read }) {
  const { data } = useQuery({ queryKey: [...ACTION_ITEMS_KEY, account], queryFn: read, staleTime: 60_000 });
  return <p>Verified action count: {data?.total ?? "loading"}</p>;
}
beforeEach(() => {
  sessionStorage.clear(); vi.clearAllMocks(); mocks.supported = true;
  mocks.account = { isConnected: true, address: account, chainId: 421614 }; mocks.user = { id: account };
  mocks.read.mockReset().mockResolvedValue(model()); mocks.sync.mockReset().mockResolvedValue({});
  mocks.write.mockReset().mockResolvedValue({ transactionHash: hash }); mocks.confirm.mockReset().mockResolvedValue({ transactionHash: hash });
  mocks.readContract.mockReset().mockResolvedValue(10_000_000n);
});
afterEach(cleanup);
describe("open funding grant workflow UI", () => {
  it.each([false, true])("refreshes an active action count after grant acceptance confirmation (recovery=%s)", async recovery => {
    let total = 1;
    mocks.read.mockResolvedValue(model({ canDeposit: false, selections: [{ ...proposal, status: "pending", canAccept: true }] }));
    if (recovery) {
      mocks.write.mockImplementation(async input => {
        input.onProgress({ status: "pending", action: "accept", transactionHash: hash });
        throw new Error("Confirmation unavailable");
      });
      mocks.confirm.mockImplementation(async () => { total = 0; return { transactionHash: hash }; });
    } else mocks.write.mockImplementation(async () => { total = 0; return { transactionHash: hash }; });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    for (const name of ["funderDashboard", "escrowFundingSummary"]) client.setQueryData([name, account], {});
    render(<QueryClientProvider client={client}><ActionCount read={async () => ({ total })} /><OpenFundingPanel problemId="grant" /></QueryClientProvider>);
    await screen.findByText("Verified action count: 1");
    fireEvent.click(await screen.findByRole("button", { name: "Accept grant" }));
    if (recovery) fireEvent.click(await screen.findByRole("button", { name: "Check transaction" }));
    await screen.findByText("Verified action count: 0");
    expect(mocks.write).toHaveBeenCalledTimes(1);
    await waitFor(() => { for (const name of ["funderDashboard", "escrowFundingSummary"]) expect(client.getQueryState([name, account]).isInvalidated).toBe(true); });
    client.clear();
  });
  it("routes grant selection through the grant API with a proposal reference", async () => {
    render(<OpenFundingPanel problemId="grant" />);
    fireEvent.click(await screen.findByRole("button", { name: "Select for funding" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ problemId: "grant", proposalId: "solution", action: "select", account })));
    expect(await screen.findByText("Offer recorded. The researcher has seven days to accept.")).toBeTruthy();
  });
  it("puts this proposal's amount-specific grant offer before the shared-pool top up", async () => {
    mocks.read.mockResolvedValue(model({ tokenSymbol: "USDT", totalDeposited: "1100000000", available: "1100000000", selections: [{ ...proposal, amountBaseUnits: "100000000" }] }));
    render(<OpenFundingPanel problemId="grant" proposalId="solution" />);
    const offer = await screen.findByRole("button", { name: "Offer 100 USDT grant" });
    const topUp = screen.getByRole("button", { name: "Add to grant pool" });

    expect(offer.compareDocumentPosition(topUp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/The researcher must accept before it moves into this proposal’s escrow/)).toBeTruthy();
    fireEvent.click(offer);
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ problemId: "grant", proposalId: "solution", action: "select", account })));
    expect(mocks.write).toHaveBeenCalledTimes(1);
    await screen.findByText("Offer recorded. The researcher has seven days to accept.");
  });
  it("submits a top up using the current token's precision", async () => {
    render(<OpenFundingPanel problemId="grant" />);
    fireEvent.change(await screen.findByLabelText("Add funding"), { target: { value: "10000.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit funds" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ action: "deposit", amount: "10000.25", decimals: 6 })));
  });
  it("keeps hashless submission progress transient and permits the same action to recover", async () => {
    const problemId = "hashless-recovery-grant";
    let finishScan;
    const scan = new Promise(resolve => { finishScan = resolve; });
    mocks.write.mockImplementationOnce(async input => {
      input.onProgress({ status: "pending", action: "deposit" });
      await scan;
      throw Object.assign(new Error("Submitted operation is still unresolved"), { walletOutcome: "pending" });
    });
    const panelRecords = () => Object.keys(sessionStorage).filter(key => key.startsWith("qcdao:grant-pending:") && key.includes(problemId));
    const view = render(<OpenFundingPanel problemId={problemId} />);
    fireEvent.change(await screen.findByLabelText("Add funding"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit funds" }));
    await screen.findByText("Transaction submitted. Waiting for confirmation…");
    expect(panelRecords()).toEqual([]);
    await act(async () => { finishScan(); });
    await screen.findByText("Submitted operation is still unresolved");
    expect(screen.getByRole("button", { name: "Deposit funds" }).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Check transaction" })).toBeNull();
    expect(panelRecords()).toEqual([]);
    view.unmount();
    render(<OpenFundingPanel problemId={problemId} />);
    const amount = await screen.findByLabelText("Add funding");
    expect(amount.value).toBe("10");
    fireEvent.click(screen.getByRole("button", { name: "Deposit funds" }));
    await screen.findByText("Deposit confirmed. The funds are now available in the grant pool.");
    expect(mocks.write).toHaveBeenCalledTimes(2);
    for (const [input] of mocks.write.mock.calls) expect(input).toEqual(expect.objectContaining({ problemId, action: "deposit", account, amount: "10" }));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(panelRecords()).toEqual([]);
  });
  it.each([
    ["a researcher", { canWithdraw: false, closed: true }],
    ["a posting that is still open", { canWithdraw: true, closed: false }],
    ["a pool with no available funds", { canWithdraw: true, closed: true, available: "0" }],
  ])("hides owner withdrawals for %s", (_case, flags) => {
    render(<OpenFundingView data={model(flags)} amount="" walletReady />);
    expect(screen.queryByLabelText("Withdraw available funding")).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw funds" })).toBeNull();
  });
  it("validates the owner's withdrawal against unreserved funds and token precision", async () => {
    mocks.read.mockResolvedValue(model({ canWithdraw: true, closed: true, available: "10000250000" }));
    render(<OpenFundingPanel problemId="grant" />);
    const input = await screen.findByLabelText("Withdraw available funding");
    const button = screen.getByRole("button", { name: "Withdraw funds" });
    expect(button.disabled).toBe(true);
    for (const amount of ["0", "-1", "10000.250001", "1.0000001"]) {
      fireEvent.change(input, { target: { value: amount } });
      expect(button.disabled).toBe(true);
      expect(input.getAttribute("aria-invalid")).toBe("true");
    }
    expect(mocks.write).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "10000.25" } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({
      action: "withdraw", amount: "10000.25", decimals: 6, account, tokenAddress: model().tokenAddress,
    })));
    expect(await screen.findByText("Withdrawal confirmed. Unreserved funds have returned to your wallet.")).toBeTruthy();
  });
  it("requires the owner's connected wallet for withdrawals", () => {
    render(<OpenFundingView data={model({ canWithdraw: true, closed: true })} amount="" withdrawalAmount="1" walletReady={false} />);
    expect(screen.getByRole("button", { name: "Withdraw funds" }).disabled).toBe(true);
  });
  it("disables selection when existing reservations leave too little available", () => {
    render(<OpenFundingView data={model({ available: "49000000000", totalReserved: "51000000000" })} amount="" walletReady />);
    expect(screen.queryByRole("button", { name: "Select for funding" })).toBeNull();
    expect(screen.getByText("Deposit more funds to cover this request.")).toBeTruthy();
  });
  it("allows a researcher to accept their pending offer, and uses void cleanup for expired offers", () => {
    const action = vi.fn();
    const view = render(<OpenFundingView data={model({ canDeposit: false, selections: [{ ...proposal, status: "pending", canAccept: true }] })} amount="" walletReady onAction={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept grant" })); expect(action).toHaveBeenCalledWith("accept", "solution");
    view.rerender(<OpenFundingView data={model({ selections: [{ ...proposal, status: "expired", canVoid: true }] })} amount="" walletReady onAction={action} />);
    expect(screen.queryByRole("button", { name: "Accept grant" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Void expired offer" })); expect(action).toHaveBeenCalledWith("void", "solution");
  });
  it("fails closed with a clear deployment message and no grant read or write on the older deployment", async () => {
    mocks.supported = false; render(<OpenFundingPanel problemId="grant" />);
    expect(await screen.findByText(/current contract deployment/)).toBeTruthy(); expect(mocks.read).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Deposit funds" })).toBeNull();
  });
  it("checks a saved transaction instead of broadcasting another deposit", async () => {
    mocks.write.mockImplementation(async input => {
      input.onProgress({ status: "pending", transactionHash: hash, action: "deposit" }); throw new Error("Confirmation unavailable");
    });
    const view = render(<OpenFundingPanel problemId="grant" />);
    fireEvent.change(await screen.findByLabelText("Add funding"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit funds" }));
    await screen.findByRole("button", { name: "Check transaction" }); view.unmount();
    render(<OpenFundingPanel problemId="grant" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check transaction" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(hash, { confirmations: 2 }));
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
  it.each([["approve", 10_000_000n, "Token approval confirmed"], ["resetAllowance", 0n, "Token allowance reset confirmed"]])(
    "recovers a late %s receipt without treating approval as a grant deposit", async (action, allowance, message) => {
      mocks.readContract.mockResolvedValue(allowance);
      mocks.write.mockImplementation(async input => {
        input.onProgress({ status: "pending", transactionHash: hash, action });
        throw new Error("Confirmation unavailable");
      });
      // An ERC20 approval has no canonical grant-pool event.
      mocks.sync.mockRejectedValue(new Error("This transaction has no confirmed action for the canonical grant pool."));
      const view = render(<OpenFundingPanel problemId="approval-recovery-grant" />);
      fireEvent.change(await screen.findByLabelText("Add funding"), { target: { value: "10" } });
      fireEvent.click(screen.getByRole("button", { name: "Deposit funds" }));
      await screen.findByRole("button", { name: "Check transaction" });
      view.unmount();
      render(<OpenFundingPanel problemId="approval-recovery-grant" />);
      fireEvent.click(await screen.findByRole("button", { name: "Check transaction" }));
      await screen.findByText(`${message}. No funds were deposited. Review the amount and deposit funds when ready.`);
      expect(mocks.confirm).toHaveBeenCalledWith(hash, { confirmations: 2 });
      expect(mocks.readContract).toHaveBeenCalledWith(expect.objectContaining({
        address: model().tokenAddress, functionName: "allowance", args: [account, model().poolAddress], chainId: 421614,
      }));
      expect(mocks.sync).not.toHaveBeenCalled();
      expect(mocks.write).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("button", { name: "Check transaction" })).toBeNull();
      const amount = screen.getByLabelText("Add funding");
      expect(amount.disabled).toBe(false);
      fireEvent.change(amount, { target: { value: "10" } });
      expect(screen.getByRole("button", { name: "Deposit funds" }).disabled).toBe(false);
    },
  );
  it("retains a confirmed approval until its fresh allowance is readable", async () => {
    mocks.write.mockImplementation(async input => {
      input.onProgress({ status: "pending", transactionHash: hash, action: "approve" });
      throw new Error("Confirmation unavailable");
    });
    mocks.readContract.mockRejectedValueOnce(new Error("Allowance RPC unavailable"));
    render(<OpenFundingPanel problemId="approval-retry-grant" />);
    fireEvent.change(await screen.findByLabelText("Add funding"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit funds" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check transaction" }));
    await screen.findByText("Allowance RPC unavailable");
    expect(screen.getByRole("button", { name: "Deposit funds" }).disabled).toBe(true);
    expect(mocks.sync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check transaction" }));
    await screen.findByText("Token approval confirmed. No funds were deposited. Review the amount and deposit funds when ready.");
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Check transaction" })).toBeNull();
  });
  it.each(["approve", "resetAllowance", "deposit"])(
    "keeps the known %s hash when receipt verification fails before pending progress", async step => {
      mocks.readContract.mockResolvedValue(step === "resetAllowance" ? 0n : 10_000_000n);
      mocks.write.mockImplementation(async input => {
        input.onProgress({ status: "awaiting_signature", action: step });
        throw Object.assign(new Error("Receipt RPC unavailable"), { transactionHash: hash });
      });
      const view = render(<OpenFundingPanel problemId={`known-${step}-grant`} />);
      fireEvent.change(await screen.findByLabelText("Add funding"), { target: { value: "10" } });
      fireEvent.click(screen.getByRole("button", { name: "Deposit funds" }));
      await screen.findByText("Receipt RPC unavailable");
      expect(screen.getByRole("button", { name: "Deposit funds" }).disabled).toBe(true);
      const saved = JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key => key.startsWith("qcdao:grant-pending:") && key.includes(`known-${step}-grant`))));
      expect(saved).toMatchObject({ transactionHash: hash, action: step });
      if (step !== "deposit") expect(saved).toMatchObject({ tokenAddress: model().tokenAddress, poolAddress: model().poolAddress });
      view.unmount();
      render(<OpenFundingPanel problemId={`known-${step}-grant`} />);
      fireEvent.click(await screen.findByRole("button", { name: "Check transaction" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Check transaction" })).toBeNull());
      expect(mocks.confirm).toHaveBeenCalledWith(hash, { confirmations: 2 });
      if (step === "deposit") {
        expect(mocks.sync).toHaveBeenCalledWith(expect.objectContaining({ transactionHash: hash }));
        expect(mocks.readContract).not.toHaveBeenCalled();
      } else {
        expect(mocks.sync).not.toHaveBeenCalled();
        expect(mocks.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "allowance", args: [account, model().poolAddress] }));
      }
      expect(mocks.write).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("Add funding").disabled).toBe(false);
    },
  );
  it.each([{ terminal: true }, { transactionSettled: true }])("does not retain a settled transaction hash (%j)", async outcome => {
    mocks.write.mockImplementation(async input => {
      input.onProgress({ status: "awaiting_signature", action: "approve" });
      throw Object.assign(new Error("Transaction reverted"), { transactionHash: hash, ...outcome });
    });
    render(<OpenFundingPanel problemId="settled-approval-grant" />);
    fireEvent.change(await screen.findByLabelText("Add funding"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit funds" }));
    await screen.findByText("Transaction reverted");
    expect(screen.queryByRole("button", { name: "Check transaction" })).toBeNull();
    expect(screen.getByRole("button", { name: "Deposit funds" }).disabled).toBe(false);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it("does not unlock an approval recovery for a different canonical pool", async () => {
    mocks.write.mockImplementation(async input => {
      input.onProgress({ status: "pending", transactionHash: hash, action: "approve" });
      throw new Error("Confirmation unavailable");
    });
    render(<OpenFundingPanel problemId="changed-approval-pool" />);
    fireEvent.change(await screen.findByLabelText("Add funding"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit funds" }));
    const check = await screen.findByRole("button", { name: "Check transaction" });
    mocks.read.mockResolvedValue(model({ poolAddress: `0x${"d".repeat(40)}` }));
    fireEvent.click(check);
    await screen.findByText("The approved token or grant pool changed. Refresh before continuing.");
    expect(mocks.readContract).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Deposit funds" }).disabled).toBe(true);
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
  it("recovers a pending withdrawal without broadcasting it again", async () => {
    mocks.read.mockResolvedValue(model({ canWithdraw: true, closed: true }));
    mocks.write.mockImplementation(async input => {
      input.onProgress({ status: "pending", transactionHash: hash, action: "withdrawAvailable" });
      throw new Error("Confirmation unavailable");
    });
    const view = render(<OpenFundingPanel problemId="withdrawal-grant" />);
    fireEvent.change(await screen.findByLabelText("Withdraw available funding"), { target: { value: "1.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw funds" }));
    await screen.findByRole("button", { name: "Check transaction" });
    expect(screen.getByRole("button", { name: "Withdraw funds" }).disabled).toBe(true);
    view.unmount();
    render(<OpenFundingPanel problemId="withdrawal-grant" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check transaction" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(hash, { confirmations: 2 }));
    expect(mocks.sync).toHaveBeenCalledWith(expect.objectContaining({ problemId: "withdrawal-grant", transactionHash: hash }));
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
  it.each(["disconnected", "wrong wallet"])("requires the signed-in wallet before signing (%s)", async mode => {
    if (mode === "disconnected") mocks.account.isConnected = false;
    else mocks.account.address = `0x${"c".repeat(40)}`;
    render(<OpenFundingPanel problemId="grant" />);
    const button = await screen.findByRole("button", { name: "Select for funding" }); expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to use your wallet" })); expect(mocks.signIn).toHaveBeenCalledOnce();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("lets the matching embedded wallet initiate grant funding on a stale reported network", async () => {
    mocks.account.chainId = 1;
    render(<OpenFundingPanel problemId="network-recovery-grant" />);
    fireEvent.change(await screen.findByLabelText("Add funding"), { target: { value: "2.5" } });
    const deposit = screen.getByRole("button", { name: "Deposit funds" });
    expect(deposit.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Sign in to use your wallet" })).toBeNull();
    fireEvent.click(deposit);
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ account, action: "deposit", amount: "2.5" })));
  });
});

it("removes stale grant actions when the refreshed record fails verification", async () => {
  render(<OpenFundingPanel problemId="grant" />);
  await screen.findByRole("button", { name: "Deposit funds" });
  mocks.read.mockRejectedValueOnce(new Error("Mismatch detected in the funding opportunity."));
  fireEvent.click(screen.getByRole("button", { name: "Refresh grant pool" }));
  await screen.findByText("Mismatch detected in the funding opportunity.");
  expect(screen.queryByRole("button", { name: "Deposit funds" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Select for funding" })).toBeNull();
});

it("blocks deposits and selection on an integrity mismatch while allowing a confirmed closed-pool withdrawal", () => {
  const action = vi.fn();
  render(<OpenFundingView data={model({ canWithdraw: true, closed: true })} integrityBlocked walletReady amount="1" withdrawalAmount="1" onAction={action} />);
  expect(screen.getByRole("button", { name: "Deposit funds" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Select for funding" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Withdraw funds" }));
  expect(action).toHaveBeenCalledWith("withdraw");
});


it.each([false, true])("renders the verified grant sync response without another summary read (recovery=%s)", async recovery => {
  mocks.sync.mockResolvedValue(model({ problemId: "grant", totalReserved: "50000000000", available: "50000000000",
    selections: [{ ...proposal, status: "pending", canSelect: false }] }));
  if (recovery) mocks.write.mockImplementation(async input => {
    input.onProgress({ status: "pending", transactionHash: hash, action: "select" }); throw new Error("Confirmation unavailable");
  });
  render(<OpenFundingPanel problemId="grant" />);
  fireEvent.click(await screen.findByRole("button", { name: "Select for funding" }));
  if (recovery) fireEvent.click(await screen.findByRole("button", { name: "Check transaction" }));
  await screen.findByText(recovery ? "Transaction confirmed. The grant pool has been refreshed." : "Offer recorded. The researcher has seven days to accept.");
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Select for funding" })).toBeNull();
});

it("does not apply a delayed grant sync response to another wallet", async () => {
  let finish;
  mocks.sync.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<OpenFundingPanel problemId="grant" />);
  fireEvent.click(await screen.findByRole("button", { name: "Select for funding" }));
  await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
  mocks.user = { id: `0x${"d".repeat(40)}` }; mocks.account = { ...mocks.account, address: mocks.user.id };
  mocks.read.mockResolvedValue(model({ selections: [], canDeposit: false }));
  view.rerender(<OpenFundingPanel problemId="grant" />);
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
  await act(async () => finish(model()));
  expect(screen.queryByRole("button", { name: "Select for funding" })).toBeNull();
  expect(screen.queryByText("Offer recorded. The researcher has seven days to accept.")).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh grant pool" }).disabled).toBe(false);
});

it("keeps a slow grant read single-flight across polling ticks", async () => {
  vi.useFakeTimers();
  let finish;
  mocks.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  try {
    const view = render(<OpenFundingPanel problemId="slow-grant" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await act(async () => finish(model()));
    view.unmount();
  } finally { vi.useRealTimers(); }
});


it("refreshes grant pool activity without clearing the entered contribution or requesting a wallet action", async () => {
  render(<OpenFundingPanel problemId="live-pool" />);
  await waitFor(() => expect(live.options.blocked).toBe(false));
  const amount = screen.getByLabelText("Add funding");
  fireEvent.change(amount, { target: { value: "12" } });
  await act(async () => { await live.options.onRefresh(); });
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(amount.value).toBe("12");
  expect(live.options).toMatchObject({ problemId: "live-pool", channel: "funding", identity: account });
  expect(mocks.write).not.toHaveBeenCalled();
});

describe("grant pool input survives refreshes (QA)", () => {
  it("keeps the Add funding amount typed after Create grant pool through refreshes and a remount", async () => {
    mocks.read.mockResolvedValueOnce(model({ poolAddress: null, canCreate: true, canDeposit: true, totalDeposited: "0", available: "0" }));
    mocks.sync.mockResolvedValue(model({ problemId: "new-pool", totalDeposited: "0", available: "0" }));
    const view = render(<OpenFundingPanel problemId="new-pool" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create grant pool" }));
    await screen.findByText(/Grant pool created/);
    const amount = screen.getByLabelText("Add funding");
    fireEvent.change(amount, { target: { value: "250" } });
    const slow = deferred(); mocks.read.mockReturnValueOnce(slow.promise);
    await act(async () => { void live.options.onRefresh(); });
    expect(screen.getByLabelText("Add funding").value).toBe("250");
    expect(screen.getByLabelText("Add funding").disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Deposit funds" }).disabled).toBe(false);
    await act(async () => { slow.resolve(model()); });
    view.unmount();
    render(<OpenFundingPanel problemId="new-pool" />);
    expect((await screen.findByLabelText("Add funding")).value).toBe("250");
    fireEvent.click(screen.getByRole("button", { name: "Deposit funds" }));
    await waitFor(() => expect(mocks.write).toHaveBeenLastCalledWith(expect.objectContaining({ action: "deposit", amount: "250" })));
    await screen.findByText(/Deposit confirmed/);
    expect(screen.getByLabelText("Add funding").value).toBe("");
  });
  it("shows grant deadlines in UTC and explains how a researcher can decline", () => {
    render(<OpenFundingView data={model({ canDeposit: false, selections: [{ ...proposal, status: "pending", canAccept: true, acceptanceDeadline: "2000000000" }] })} amount="" walletReady />);
    expect(screen.getByText("Accept before 2033-05-18 03:33:20 UTC")).toBeTruthy();
    expect(screen.getByText(/Not taking this grant\?/)).toBeTruthy();
  });
  it("hides the recovery prompt while the in-flight action owns its transaction", () => {
    render(<OpenFundingView data={model()} amount="1" walletReady busy progress={{ status: "pending", transactionHash: hash }} pending={{ transactionHash: hash }} />);
    expect(screen.queryByText(/still needs confirmation/)).toBeNull();
    expect(screen.getByText("Transaction submitted. Waiting for confirmation…")).toBeTruthy();
  });
});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe("researcher declines a grant offer", () => {
  const offer = { ...proposal, status: "pending", canAccept: true, canDecline: true, acceptanceDeadline: "2000000000" };
  it("requires a 10–2,000 character reason and a confirmation before declining", async () => {
    mocks.read.mockResolvedValue(model({ canDeposit: false, canSelect: false, selections: [offer] }));
    mocks.sync.mockResolvedValue(model({ canDeposit: false, canSelect: false, available: "100000000000",
      selections: [{ ...offer, status: "voided", canAccept: false, canDecline: false, declined: true, declineReason: "Funded by another sponsor already." }] }));
    render(<OpenFundingPanel problemId="grant" />);
    expect(await screen.findByText(/Decline the offer to return the reserved amount/)).toBeTruthy();
    expect(screen.queryByText(/Leave it unaccepted/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Decline grant offer" }));
    const input = screen.getByLabelText("Reason for declining");
    const confirm = screen.getByRole("button", { name: "Confirm decline" });
    expect(input.getAttribute("maxLength")).toBe("2000");
    expect(confirm.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Accept grant" }).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  too short" } });
    expect(screen.getByText("Enter at least 10 characters.")).toBeTruthy(); expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Keep offer" }));
    expect(screen.queryByLabelText("Reason for declining")).toBeNull();
    expect(mocks.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Decline grant offer" }));
    fireEvent.change(screen.getByLabelText("Reason for declining"), { target: { value: "Funded by another sponsor already." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm decline" }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ problemId: "grant", proposalId: "solution",
      action: "decline", reason: "Funded by another sponsor already.", account })));
    expect(await screen.findByText(/Grant offer declined. The reserved amount has returned/)).toBeTruthy();
    expect(mocks.sync).toHaveBeenCalledWith(expect.objectContaining({ proposalId: "solution", transactionHash: hash }));
    expect(screen.queryByLabelText("Reason for declining")).toBeNull();
    expect(screen.getByText(/Offer declined by the researcher/)).toBeTruthy();
    expect(screen.getByText("Researcher’s reason: Funded by another sponsor already.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Decline grant offer" })).toBeNull();
  });
  it("keeps the decline form and reason after a failed wallet action, and allows it on an integrity mismatch", async () => {
    mocks.read.mockResolvedValue(model({ canDeposit: false, canSelect: false, selections: [offer] }));
    mocks.write.mockRejectedValueOnce(new Error("User rejected the request."));
    render(<OpenFundingPanel problemId="grant" integrityBlocked />);
    fireEvent.click(await screen.findByRole("button", { name: "Decline grant offer" }));
    fireEvent.change(screen.getByLabelText("Reason for declining"), { target: { value: "The scope no longer fits our lab." } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm decline" }));
    expect(await screen.findByText("User rejected the request.")).toBeTruthy();
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ action: "decline", reason: "The scope no longer fits our lab." }));
    expect(screen.getByLabelText("Reason for declining").value).toBe("The scope no longer fits our lab.");
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it("shows a busy status while the decline is prepared and falls back to the expiry hint on older pools", () => {
    const view = render(<OpenFundingView data={model({ canDeposit: false, selections: [offer] })} amount="" walletReady busy
      progress={{ status: "awaiting_signature", action: "declineProposal" }} decline={{ proposalId: "solution", reason: "Already funded elsewhere." }} />);
    expect(screen.getByText("Confirm the transaction in your wallet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm decline" }).disabled).toBe(true);
    expect(screen.getByLabelText("Reason for declining").disabled).toBe(true);
    view.rerender(<OpenFundingView data={model({ canDeposit: false, selections: [{ ...offer, canDecline: false }] })} amount="" walletReady />);
    expect(screen.queryByRole("button", { name: "Decline grant offer" })).toBeNull();
    expect(screen.getByText(/Leave it unaccepted/)).toBeTruthy();
  });
});
