import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), user: { id: "member" }, live: null }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../src/hooks/useLiveActivity.js", () => ({ useLiveActivity: options => { mocks.live = options; } }));
vi.mock("../../src/lib/escrowFunding.js", () => ({
  getPostingEscrowFundingSummary: (...args) => mocks.read(...args),
  escrowFundingAmount: (units, decimals, symbol) => `${Number(units) / 10 ** decimals} ${symbol}`,
}));
vi.mock("../../src/lib/escrow.js", () => ({ escrowErrorMessage: error => error.message }));
import { PostingEscrowFunding } from "../../src/components/PostingEscrowFunding.jsx";
const summary = { proposalId: "p1", title: "Routing proposal", available: true, state: "Open",
  totalDeposited: "100000000", fundingTarget: "100000000", outstandingBalance: "100000000",
  custodyBalance: "100000000", tokenDecimals: 6, tokenSymbol: "USDC",
  expiresAt: "2000000000", timestamp: 1900000000, selectionGate: { canSelect: true },
  fundingRequirementMet: true };
beforeEach(() => { mocks.read.mockReset(); mocks.user = { id: "member" }; mocks.live = null; });
afterEach(cleanup);
function show(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><PostingEscrowFunding problemId="posting1" {...props} /></QueryClientProvider>);
}
it("shows confirmed lock and funding readiness on the posting and opens that proposal's escrow", async () => {
  mocks.read.mockResolvedValue({ items: [summary], unavailableItems: 0 });
  const onNavigate = vi.fn(); show({ onNavigate });
  await screen.findByText("Funds locked.");
  expect(screen.getByText(/Funding requirement met/).textContent).toContain("Evaluator feedback is optional");
  expect(document.querySelector("time[datetime]").getAttribute("datetime")).toBe(new Date(2000000000 * 1000).toISOString());
  fireEvent.click(screen.getByRole("button", { name: "Open escrow" }));
  expect(onNavigate).toHaveBeenCalledWith("proposal/p1?tab=funding");
  expect(mocks.read).toHaveBeenCalledWith("posting1");
});
it("keeps unavailable custody unknown until a successful explicit refresh", async () => {
  mocks.read.mockResolvedValueOnce({ items: [{ proposalId: "p1", title: "Routing proposal", available: false }], unavailableItems: 1 })
    .mockResolvedValue({ items: [summary], unavailableItems: 0 });
  show(); await screen.findByText(/Funding and lock status could not be verified/);
  expect(screen.queryByText("Funds locked.")).toBeNull();
  expect(screen.queryByText(/Funding requirement met/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh custody" }));
  await screen.findByText("Funds locked.");
  expect(mocks.read).toHaveBeenCalledTimes(2);
});
it("does not fetch the inactive tab or expose a ready selection without verified funding", async () => {
  mocks.read.mockResolvedValue({ items: [{ ...summary, fundingRequirementMet: false, selectionGate: { canSelect: false } }], unavailableItems: 0 });
  const view = show({ active: false });
  await waitFor(() => expect(mocks.read).not.toHaveBeenCalled());
  expect(mocks.live.enabled).toBe(false);
  view.unmount(); show(); await screen.findByText(/Selection requires the full target/);
  expect(screen.queryByText(/Funding requirement met/)).toBeNull();
});
