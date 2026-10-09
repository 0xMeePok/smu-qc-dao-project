import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), user: { id: "researcher" } }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../src/lib/escrowFunding.js", async importOriginal => ({ ...await importOriginal(), getEscrowFundingSummary: (...args) => mocks.fetch(...args) }));
import { EscrowReleaseSummary } from "../../src/components/EscrowReleaseSummary.jsx";
const item = { proposalId: "solution", title: "Verified quantum delivery", postingTitle: "Grant call", tokenDecimals: 6,
  tokenSymbol: "USDC", upfrontReleased: true, finalReleased: false, totalReleased: "25000000000", outstandingBalance: "25000000000" };
let queryClient;
function renderSummary(onNavigate = () => {}) {
  return render(<QueryClientProvider client={queryClient}><EscrowReleaseSummary onNavigate={onNavigate} /></QueryClientProvider>);
}
beforeEach(() => { mocks.user = { id: "researcher" }; mocks.fetch.mockReset().mockResolvedValue({ items: [item] }); });
beforeEach(() => { queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
afterEach(() => { cleanup(); queryClient.clear(); });

it("shows verified payment amounts and opens the actual funding tab", async () => {
  const go = vi.fn(); renderSummary(go);
  await screen.findByText(item.title);
  expect(screen.getByText("Upfront 50%: paid · Final 50%: pending")).toBeTruthy();
  expect(screen.getByText("Released before fees: 25000 USDC · Held: 25000 USDC")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open escrow" }));
  expect(go).toHaveBeenCalledWith("proposal/solution?tab=funding");
});

it("retains unavailable and truncation warnings when no payments can be verified", async () => {
  mocks.fetch.mockResolvedValue({ items: [], unavailableItems: 2, truncated: true });
  renderSummary();
  expect(await screen.findByText(/2 proposal payment records could not be loaded/)).toBeTruthy();
  expect(screen.getByText(/This payment summary is limited/)).toBeTruthy();
  expect(screen.getByText("Proposal payments are temporarily unavailable.")).toBeTruthy();
  expect(screen.queryByText(/No confirmed escrow payments yet/)).toBeNull();
  mocks.fetch.mockResolvedValue({ items: [item], unavailableItems: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Refresh payments" }));
  await screen.findByText(item.title);
  expect(screen.queryByText(/could not be loaded/)).toBeNull();
});

it.each(["Cancelled", "Refunded", "Expired", "Voided"])("does not imply future payments are pending for a %s escrow", async state => {
  mocks.fetch.mockResolvedValue({ items: [{ ...item, state, upfrontReleased: false, finalReleased: false }] });
  renderSummary();
  await screen.findByText(item.title);
  expect(screen.getByText("Upfront 50%: no longer payable · Final 50%: no longer payable")).toBeTruthy();
  expect(screen.queryByText(/50%: pending/)).toBeNull();
});

it("retains a confirmed upfront payout when the unpaid completion portion expires", async () => {
  mocks.fetch.mockResolvedValue({ items: [{ ...item, state: "Expired" }] });
  renderSummary();
  expect(await screen.findByText("Upfront 50%: paid · Final 50%: no longer payable")).toBeTruthy();
  expect(screen.getByText("Released before fees: 25000 USDC · Held: 25000 USDC")).toBeTruthy();
});

it("keeps the last verified payments visible while a remounted tab fetches current results", async () => {
  const first = renderSummary();
  await screen.findByText(item.title);
  first.unmount();
  let finish;
  mocks.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));

  renderSummary();
  expect(screen.getByText(item.title)).toBeTruthy();
  expect(screen.getByText("Refreshing payments… Showing previously loaded results.")).toBeTruthy();
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "Refresh payments" }).disabled).toBe(true);

  await act(async () => finish({ items: [{ ...item, finalReleased: true, totalReleased: "50000000000", outstandingBalance: "0" }] }));
  expect(await screen.findByText("Upfront 50%: paid · Final 50%: paid")).toBeTruthy();
  expect(screen.queryByText(/Refreshing payments/)).toBeNull();
});

it("labels retained verified results if refreshing fails", async () => {
  renderSummary();
  await screen.findByText(item.title);
  mocks.fetch.mockRejectedValue(new Error("RPC unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh payments" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "RPC unavailable Showing previously loaded results; open an escrow to check its current payments.");
  expect(screen.getByText(item.title)).toBeTruthy();
});

it("never displays the previous wallet's cached payments after account switching or sign-out", async () => {
  const view = renderSummary();
  await screen.findByText(item.title);
  mocks.fetch.mockImplementation(() => new Promise(() => {}));
  mocks.user = { id: "other-wallet" };
  view.rerender(<QueryClientProvider client={queryClient}><EscrowReleaseSummary onNavigate={() => {}} /></QueryClientProvider>);
  expect(screen.queryByText(item.title)).toBeNull();
  expect(screen.getByText("Loading payments…")).toBeTruthy();
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));

  mocks.user = null;
  view.rerender(<QueryClientProvider client={queryClient}><EscrowReleaseSummary onNavigate={() => {}} /></QueryClientProvider>);
  expect(screen.queryByRole("region", { name: "Escrow payment summary" })).toBeNull();
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});

it("shares an in-flight summary request between simultaneous mounts", async () => {
  mocks.fetch.mockImplementation(() => new Promise(() => {}));
  render(<QueryClientProvider client={queryClient}>
    <EscrowReleaseSummary onNavigate={() => {}} />
    <EscrowReleaseSummary onNavigate={() => {}} />
  </QueryClientProvider>);
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
});


it("refreshes payment changes automatically while visible and catches up after returning", async () => {
  vi.useFakeTimers(); focusManager.setFocused(true);
  try {
    renderSummary();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByText("Upfront 50%: paid · Final 50%: pending")).toBeTruthy();
    mocks.fetch.mockResolvedValue({ items: [{ ...item, finalReleased: true, totalReleased: "50000000000", outstandingBalance: "0" }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(screen.getByText("Upfront 50%: paid · Final 50%: paid")).toBeTruthy();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    act(() => focusManager.setFocused(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(180000); });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    await act(async () => { focusManager.setFocused(true); await vi.advanceTimersByTimeAsync(10); });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  } finally { cleanup(); queryClient.clear(); focusManager.setFocused(undefined); vi.useRealTimers(); }
});
