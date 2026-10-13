import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { FundingProgress, FundingContributors } from "../../src/components/FundingProgress.jsx";
import { EscrowLifecycleBadge, EscrowMoneySummary, EscrowLifecycleTimeline } from "../../src/components/EscrowLifecycle.jsx";

afterEach(cleanup);
const wallet = `0x${"a".repeat(40)}`, hash = `0x${"b".repeat(64)}`;
const summary = { verified: true, state: "Active", totalDeposited: "3000000", fundingTarget: "3000000", tokenDecimals: 6, tokenSymbol: "USDC",
  outstandingBalance: "1500000", totalReleased: "1500000", totalRefunded: "0", blockNumber: 100, timestamp: 1900000000 };

it("explains the specific refund trigger without treating a queued request as cancellation", () => {
  const view = render(<EscrowLifecycleBadge summary={{ ...summary, state: "Expired", refundReason: "funding_target_not_met" }} />);
  expect(screen.getByText("Refund reason: The funding target was not reached before the posting closed.")).toBeTruthy();
  view.rerender(<EscrowLifecycleBadge summary={{ ...summary, state: "Open", refundReason: "admin_cancelled", cancellation: { status: "queued" } }} />);
  expect(screen.queryByText(/Refund reason:/)).toBeNull();
  expect(screen.getByLabelText("Escrow state: Pending")).toBeTruthy();
});

it("shows exact raised/required progress and a fully funded indicator", () => {
  render(<FundingProgress summary={{ ...summary, totalDeposited: "900719925474099312345678", fundingTarget: "900719925474099312345678" }} />);
  expect(screen.getByText("900719925474099312.345678 USDC raised of 900719925474099312.345678 USDC required · 100%")).toBeTruthy();
  expect(screen.getByText("Fully funded")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("100% funded");
});

it("shows partial percentages without treating unavailable or stale balances as zero", () => {
  const view = render(<FundingProgress summary={{ ...summary, totalDeposited: "1000000" }} />);
  expect(screen.getByText("1 USDC raised of 3 USDC required · 33.33%")).toBeTruthy();
  expect(screen.queryByText("Fully funded")).toBeNull();
  view.rerender(<FundingProgress summary={summary} stale />);
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByText(/Funding progress needs verification/)).toBeTruthy();
});

it("lists public names, wallets, exact contribution and proportional share without exposing profiles", () => {
  render(<FundingContributors summary={{ ...summary, contributors: { available: true, complete: true,
    items: [{ walletAddress: wallet, displayName: "Alicia Tan", committed: "1000000", email: "private@example.com" },
      { walletAddress: `0x${"c".repeat(40)}`, committed: "2000000" }] } }} />);
  const table = screen.getByRole("table");
  expect(within(table).getByText("Alicia Tan")).toBeTruthy();
  expect(within(table).getByText("1 USDC")).toBeTruthy();
  expect(within(table).getByText("33.33%")).toBeTruthy();
  expect(within(table).getByText("66.66%")).toBeTruthy();
  expect(screen.queryByText("private@example.com")).toBeNull();
  expect(screen.getByRole("link", { name: `Wallet ${wallet}` }).getAttribute("href")).toContain(wallet);
});

it("labels incomplete contributors unavailable rather than claiming the visible subset is complete", () => {
  render(<FundingContributors summary={{ ...summary, contributors: { available: true, complete: false, items: [{ walletAddress: wallet, committed: "1000000" }] } }} />);
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByText(/Confirmed contributor details are unavailable/)).toBeTruthy();
});

it("does not call recorded target funding sufficient when confirmed custody is short", () => {
  render(<FundingProgress summary={{ ...summary, state: "Open", fundingRequirementMet: false, custodyBalance: "1" }} />);
  expect(screen.getByText(/Target reached; custody requirement not met/)).toBeTruthy();
  expect(screen.queryByText("Fully funded")).toBeNull();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("100% funded");
});

it("distinguishes confirmed escrow state, held money, paid money and returned money", () => {
  render(<><EscrowLifecycleBadge summary={summary} /><EscrowMoneySummary summary={summary} /></>);
  expect(screen.getByLabelText("Escrow state: Locked")).toBeTruthy();
  expect(screen.getByText(/The upfront payment has been released/)).toBeTruthy();
  expect(screen.getByText("Held in escrow").nextElementSibling.textContent).toBe("1.5 USDC");
  expect(screen.getByText("Released before fees").nextElementSibling.textContent).toBe("1.5 USDC");
  expect(screen.getByText("Refunded to contributors").nextElementSibling.textContent).toBe("0 USDC");
});

it("provides confirmed timestamps and audit receipt/explorer links for state changes", () => {
  render(<EscrowLifecycleTimeline summary={summary} events={[
    { id: "pending", type: "Cancelled", verified: false, transactionHash: hash, blockNumber: 100, timestamp: 1900000000 },
    { id: "confirmed", type: "SelectionLocked", verified: true, transactionHash: hash, blockNumber: 100, timestamp: 1900000000 },
  ]} />);
  expect(screen.getByText("Selection confirmed · Locked")).toBeTruthy();
  expect(screen.queryByText("Escrow cancelled")).toBeNull();
  expect(document.querySelector("time").getAttribute("datetime")).toBe(new Date(1900000000 * 1000).toISOString());
  expect(screen.getByRole("link", { name: "Confirmed transaction" }).getAttribute("href")).toBe(`https://sepolia.arbiscan.io/tx/${hash}`);
  expect(screen.getByRole("link", { name: "Anchored audit receipt" }).getAttribute("href")).toBe(`https://sepolia.arbiscan.io/tx/${hash}#eventlog`);
});

it("uses the confirmed admin cancellation reason while retaining the contract receipt and final refund state", () => {
  const view = render(<><EscrowLifecycleBadge summary={{ ...summary, state: "Voided", refundReason: "admin_cancelled" }} />
    <EscrowLifecycleTimeline summary={summary} events={[{ type: "Voided", refundReason: "admin_cancelled", stateAfter: "Voided",
      verified: true, transactionHash: hash, blockNumber: 100, timestamp: 1900000000 }]} /></>);
  expect(screen.getByLabelText("Escrow state: Cancelled")).toBeTruthy();
  expect(screen.getByText("Administrator cancellation · Cancelled")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Anchored audit receipt" }).getAttribute("href")).toContain(hash);
  view.rerender(<EscrowLifecycleBadge summary={{ ...summary, state: "Refunded", refundReason: "admin_cancelled", invalidated: true }} />);
  expect(screen.getByLabelText("Escrow state: Refunded")).toBeTruthy();
});
