import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: { id: "owner" }, read: vi.fn() }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../src/lib/firebase.js", () => ({ functions: {} }));
vi.mock("../../src/lib/matching.js", async (importOriginal) => ({
  ...await importOriginal(),
  getMockMatching: (...args) => mocks.read(...args),
}));
import { MatchingPanel } from "../../src/components/MatchingPanel.jsx";

const candidate = (overrides = {}) => ({
  id: "proposal-1",
  title: "Quantum routing",
  currency: "USD",
  amount: 100,
  fundedAmount: 100,
  matching: { status: "funding" },
  canFund: false,
  canSelect: false,
  canConfirm: false,
  canDecline: false,
  canApproveOwner: false,
  ...overrides,
});

beforeEach(() => {
  mocks.user = { id: "owner" };
  mocks.read.mockReset();
});
afterEach(cleanup);

it("routes escrow proposals to their wallet detail and ignores stale mock capabilities", async () => {
  const navigate = vi.fn();
  mocks.read.mockResolvedValue({
    matching: { status: "awaiting_confirmation", proposalId: "proposal-1", deadlineAt: "2099-09-22T00:00:00Z" },
    canForceExpire: true,
    proposals: [candidate({
      fundingTerms: { trancheBps: [5000, 5000] },
      canFund: true,
      canConfirm: true,
      canDecline: true,
      canCompleteEvaluation: true,
    })],
    contributions: [{ id: "old", amount: 100, currency: "USD", status: "locked" }],
  });
  render(<MatchingPanel problemId="problem-1" onNavigate={navigate} />);
  fireEvent.click(await screen.findByRole("button", { name: "View escrow proposal" }));
  expect(navigate).toHaveBeenCalledWith("proposal/proposal-1");
  for (const name of ["Fund proposal", "Accept as proposal creator", "Reject selection", "Complete mock evaluation", "Expire window for demonstration"]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
  expect(screen.queryByText("Mock funds")).toBeNull();
  expect(screen.queryByText("Seven-day acceptance window")).toBeNull();
  expect(screen.queryByRole("progressbar")).toBeNull();
});
