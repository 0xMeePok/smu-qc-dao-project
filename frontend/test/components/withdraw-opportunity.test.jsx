import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const account = `0x${"a".repeat(40)}`;
const mocks = vi.hoisted(() => ({
  posting: null,
  withdraw: vi.fn(),
  anchorWithdrawal: vi.fn(),
  connected: true,
  navigate: vi.fn(),
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ isConnected: mocks.connected, address: account }),
}));
vi.mock("../../src/lib/wagmi.js", () => ({
  wagmiConfig: {},
  isUsableConnector: () => true,
}));
vi.mock("../../src/context/AuthContext.jsx", () => ({
  useAuth: () => ({ isAuthenticated: true, user: { id: account, roles: ["funder"] } }),
}));
vi.mock("../../src/lib/postings.js", () => ({
  findPosting: async () => mocks.posting,
  withdrawPosting: (...args) => mocks.withdraw(...args),
  listOpportunityRevisions: async () => [],
}));
vi.mock("../../src/lib/postingAudit.js", () => ({
  postingAuditReceipt: () => ({ status: "queued" }),
  readPostingAudit: async () => ({ verified: true }),
  anchorPostingAudit: vi.fn(),
  anchorOpportunityWithdrawal: (...args) => mocks.anchorWithdrawal(...args),
}));
vi.mock("../../src/lib/fundingOpportunityAudit.js", () => ({
  fundingOpportunityAuditReceipt: () => ({ status: "queued" }),
  readFundingOpportunityAudit: async () => ({ verified: true }),
  anchorFundingOpportunityAudit: vi.fn(),
}));
vi.mock("../../src/components/ConnectWalletModal.jsx", () => ({
  ConnectWalletModal: () => <p>Wallet picker</p>,
}));

import PostingDetailPage from "../../src/pages/PostingDetailPage.jsx";

const problem = {
  id: "posting1",
  ownerId: account,
  organisation: "Singapore Management University",
  title: "Cold-chain route optimisation",
  summary: "Routing degrades under demand spikes.",
  status: "submitted",
  categories: ["ai"],
  amount: 80000,
  currency: "USDT",
  attachments: [],
  createdAt: new Date("2026-09-01T10:00:00Z"),
  expiresAt: new Date("2099-12-01T00:00:00Z"),
};

beforeEach(() => {
  mocks.posting = { ...problem };
  mocks.connected = true;
  mocks.navigate.mockReset();
  mocks.withdraw.mockReset().mockResolvedValue(undefined);
  mocks.anchorWithdrawal.mockReset().mockResolvedValue({ transactionHash: `0x${"4".repeat(64)}` });
});
afterEach(cleanup);

describe("withdrawing a posted opportunity", () => {
  it("will not withdraw without a reason, then signs before saving", async () => {
    render(<PostingDetailPage postingId="posting1" onNavigate={mocks.navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw problem statement" }));
    await screen.findByRole("heading", { name: "Withdraw this problem statement?" });
    fireEvent.click(screen.getByRole("button", { name: "Sign and withdraw" }));
    expect(await screen.findByText("Give a reason for withdrawing this problem statement.")).toBeTruthy();
    expect(mocks.withdraw).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Why are you withdrawing?"), {
      target: { value: "The budget was withdrawn." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign and withdraw" }));
    await waitFor(() => expect(mocks.withdraw).toHaveBeenCalledWith("posting1", "The budget was withdrawn."));
    expect(mocks.anchorWithdrawal.mock.calls[0][1].reason).toBe("The budget was withdrawn.");
    expect(await screen.findByText("The budget was withdrawn.")).toBeTruthy();
  });

  it("retries only the Firestore write when the chain already accepted the withdrawal", async () => {
    mocks.withdraw.mockRejectedValueOnce(new Error("Network unavailable"));
    render(<PostingDetailPage postingId="posting1" onNavigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw problem statement" }));
    fireEvent.change(await screen.findByLabelText("Why are you withdrawing?"), {
      target: { value: "The budget was withdrawn." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign and withdraw" }));
    expect(await screen.findByText(/will not be asked to sign again/)).toBeTruthy();
    expect(mocks.anchorWithdrawal).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Why are you withdrawing?").disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Finish saving withdrawal" }));
    await waitFor(() => expect(mocks.withdraw).toHaveBeenCalledTimes(2));
    expect(mocks.anchorWithdrawal).toHaveBeenCalledTimes(1);
    expect(mocks.withdraw.mock.calls[1]).toEqual(["posting1", "The budget was withdrawn."]);
  });

  it("keeps a funding call listed when the withdrawal is declined", async () => {
    mocks.posting = {
      ...problem,
      id: "funding1",
      opportunityType: "open-funding",
      fundingThesis: "Fund resilient supply chains.",
      eligibilityNotes: "Universities may apply.",
      tags: ["logistics"],
    };
    mocks.anchorWithdrawal.mockRejectedValueOnce(Object.assign(new Error("User rejected"), { code: 4001 }));
    render(<PostingDetailPage postingId="funding1" onNavigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw funding opportunity" }));
    fireEvent.change(await screen.findByLabelText("Why are you withdrawing?"), {
      target: { value: "The programme closed." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign and withdraw" }));
    await waitFor(() => expect(mocks.anchorWithdrawal).toHaveBeenCalled());
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });
});
