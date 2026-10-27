import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CurrencyContext } from "../../src/context/CurrencyContext.jsx";
import { FundingProgress } from "../../src/components/FundingProgress.jsx";
import { EscrowMoneySummary } from "../../src/components/EscrowLifecycle.jsx";

afterEach(cleanup);
const summary = {
  verified: true, state: "Active", totalDeposited: "3000000", fundingTarget: "3000000",
  tokenDecimals: 6, tokenSymbol: "USDC", outstandingBalance: "3000000",
  totalReleased: "0", totalRefunded: "0", blockNumber: 100, timestamp: 1900000000,
};
const rates = (localCurrency, USD, SGD) => ({
  source: "Google Finance", localCurrency, rates: { USD, SGD },
  fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
});
const funding = <><FundingProgress summary={summary} /><EscrowMoneySummary summary={{ ...summary, tokenSymbol: "XSGD", outstandingBalance: "6000000" }} compact /></>;
function view(value) {
  return <CurrencyContext.Provider value={{ localCurrency: "SGD", showLocalCurrency: true, ...value }}>{funding}</CurrencyContext.Provider>;
}

it("updates every funding estimate with the selected currency while retaining exact USDC and XSGD amounts", () => {
  const rendered = render(view({ rates: rates("SGD", 1.34, 1) }));
  expect(screen.getAllByText(/≈ SGD\s4\.02/)).toHaveLength(2);
  expect(screen.getByText(/≈ SGD\s6\.00/)).toBeTruthy();
  expect(screen.getAllByText(/3 USDC/)).toHaveLength(2);
  expect(screen.getByText(/6 XSGD/)).toBeTruthy();
  expect(screen.getAllByText(/indicative testnet/)).toHaveLength(3);

  rendered.rerender(view({ localCurrency: "EUR", rates: rates("EUR", 0.9, 0.67) }));
  expect(screen.getAllByText(/≈ EUR\s2\.70/)).toHaveLength(2);
  expect(screen.getByText(/≈ EUR\s4\.02/)).toBeTruthy();
  expect(screen.queryByText(/≈ SGD/)).toBeNull();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("100% funded");
});

it("falls back to exact token displays when rates expire, are unavailable, or the toggle is off", () => {
  const expired = { ...rates("SGD", 1.34, 1), expiresAt: new Date(Date.now() - 1).toISOString() };
  const rendered = render(view({ rates: expired }));
  for (const value of [{ rates: expired }, { rates: null }, { rates: rates("SGD", 1.34, 1), showLocalCurrency: false }]) {
    rendered.rerender(view(value));
    expect(screen.queryByText(/≈ /)).toBeNull();
    expect(screen.getByText("3 USDC raised of 3 USDC required · 100%")).toBeTruthy();
    expect(screen.getByText("6 XSGD")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("100% funded");
  }
});
