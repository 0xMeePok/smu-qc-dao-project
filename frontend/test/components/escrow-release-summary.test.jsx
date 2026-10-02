import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), user: { id: "researcher" } }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../src/lib/escrowFunding.js", async importOriginal => ({ ...await importOriginal(), getEscrowFundingSummary: (...args) => mocks.fetch(...args) }));
import { EscrowReleaseSummary } from "../../src/components/EscrowReleaseSummary.jsx";
const item = { proposalId: "solution", title: "Verified quantum delivery", postingTitle: "Grant call", tokenDecimals: 6,
  tokenSymbol: "USDC", upfrontReleased: true, finalReleased: false, totalReleased: "25000000000", outstandingBalance: "25000000000" };
beforeEach(() => { mocks.user = { id: "researcher" }; mocks.fetch.mockReset().mockResolvedValue({ items: [item] }); });
afterEach(cleanup);

it("shows verified payment amounts and opens the actual funding tab", async () => {
  const go = vi.fn(); render(<EscrowReleaseSummary onNavigate={go} />);
  await screen.findByText(item.title);
  expect(screen.getByText("Upfront 50%: paid · Final 50%: pending")).toBeTruthy();
  expect(screen.getByText("Released before fees: 25000 USDC · Held: 25000 USDC")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open escrow" }));
  expect(go).toHaveBeenCalledWith("proposal/solution?tab=funding");
});

it("retains unavailable and truncation warnings when no payments can be verified", async () => {
  mocks.fetch.mockResolvedValue({ items: [], unavailableItems: 2, truncated: true });
  render(<EscrowReleaseSummary onNavigate={() => {}} />);
  expect(await screen.findByText(/2 proposal payment records could not be verified/)).toBeTruthy();
  expect(screen.getByText(/This payment summary is limited/)).toBeTruthy();
  expect(screen.getByText("Verified proposal payments are temporarily unavailable.")).toBeTruthy();
  expect(screen.queryByText(/No confirmed escrow payments yet/)).toBeNull();
  mocks.fetch.mockResolvedValue({ items: [item], unavailableItems: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Refresh payments" }));
  await screen.findByText(item.title);
  expect(screen.queryByText(/could not be verified/)).toBeNull();
});

it.each(["Cancelled", "Refunded", "Expired", "Voided"])("does not imply future payments are pending for a %s escrow", async state => {
  mocks.fetch.mockResolvedValue({ items: [{ ...item, state, upfrontReleased: false, finalReleased: false }] });
  render(<EscrowReleaseSummary onNavigate={() => {}} />);
  await screen.findByText(item.title);
  expect(screen.getByText("Upfront 50%: no longer payable · Final 50%: no longer payable")).toBeTruthy();
  expect(screen.queryByText(/50%: pending/)).toBeNull();
});

it("retains a confirmed upfront payout when the unpaid completion portion expires", async () => {
  mocks.fetch.mockResolvedValue({ items: [{ ...item, state: "Expired" }] });
  render(<EscrowReleaseSummary onNavigate={() => {}} />);
  expect(await screen.findByText("Upfront 50%: paid · Final 50%: no longer payable")).toBeTruthy();
  expect(screen.getByText("Released before fees: 25000 USDC · Held: 25000 USDC")).toBeTruthy();
});
