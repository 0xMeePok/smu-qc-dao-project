import React from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PostingFundingProgress } from "../../src/components/PostingFundingProgress.jsx";
afterEach(cleanup);
const group = { tokenAddress: `0x${"a".repeat(40)}`, tokenSymbol: "USDC", tokenDecimals: 6, totalDeposited: "50000000", fundingTarget: "100000000", count: 2, timestamp: 1900000000, blockNumber: 100, snapshotVerified: true };
it("shows exact cached proposal-target progress without claiming the posting currency budget is escrowed", () => {
  render(<PostingFundingProgress projection={{ available: true, version: 2, groups: [group] }} />);
  expect(screen.getByText("50 USDC deposited")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByText("Across 2 proposal escrows")).toBeTruthy();
  expect(screen.getByText("Targets are per proposal.")).toBeTruthy();
});
it("does not label an aggregate as fully funded even when its combined target is met", () => {
  render(<PostingFundingProgress projection={{ available: true, version: 2, groups: [{ ...group, totalDeposited: "100000000" }] }} />);
  expect(screen.getByText("100 USDC deposited")).toBeTruthy();
  expect(screen.queryByText("Fully funded")).toBeNull();
  expect(screen.queryByRole("progressbar")).toBeNull();
});
it("keeps unavailable/truncated projections explicit instead of inventing zero funding", () => {
  render(<PostingFundingProgress projection={{ available: false, groups: [group] }} />);
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByText(/progress needs verification/)).toBeTruthy();
});

it("never shows a cancelled or refunded escrow as raised or fully funded", () => {
  render(<PostingFundingProgress projection={{ available: true, version: 2, closedItems: 1, groups: [] }} />);
  expect(screen.queryByText(/Fully funded/)).toBeNull();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByText("No active proposal escrow funding. 1 cancelled or refunded proposal escrow is not counted.")).toBeTruthy();
});
it("treats a projection cached before refunds were excluded as unverified", () => {
  const funded = { ...group, totalDeposited: "50000000", fundingTarget: "50000000", count: 1 };
  render(<PostingFundingProgress projection={{ available: true, groups: [funded] }} />);
  expect(screen.queryByText(/Fully funded/)).toBeNull();
  expect(screen.getByText(/progress needs verification/)).toBeTruthy();
});
