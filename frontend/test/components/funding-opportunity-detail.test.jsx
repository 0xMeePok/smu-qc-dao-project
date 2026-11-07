import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readPool: vi.fn(),
  syncPool: vi.fn(),
  verifyFunding: vi.fn(async () => ({ verified: true })),
  verifyProblem: vi.fn(async () => ({ verified: false })),
}));

vi.mock("../../src/lib/openFunding.js", () => ({
  openFundingSupported: () => true,
  getOpenFundingSummary: (...args) => mocks.readPool(...args),
  syncOpenFunding: (...args) => mocks.syncPool(...args),
  writeOpenFundingAction: async () => ({ transactionHash: `0x${"f".repeat(64)}` }),
}));

vi.mock("../../src/context/WalletContext.jsx", () => ({ useWallet: () => ({ address: `0x${"a".repeat(40)}`, isConnected: true }),
}));
vi.mock("../../src/components/RelatedAuditReceiptPane.jsx", () => ({
  RELATED_AUDIT_KIND: { PROPOSAL: "proposal", LISTING: "listing", COMMENT: "comment" },
  RelatedAuditReceiptPane: () => null,
}));

vi.mock("../../src/context/AuthContext.jsx", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { id: `0x${"a".repeat(40)}` },
  }),
}));

vi.mock("../../src/lib/postings.js", () => ({
  findPosting: async () => ({
    id: "funding123",
    opportunityType: "open-funding",
    ownerId: `0x${"a".repeat(40)}`,
    organisation: "Singapore Management University",
    title: "Resilient supply chains",
    fundingThesis: "Fund research into resilient supply chains.",
    eligibilityNotes: "Universities and research organisations may apply.",
    categories: ["quantum"],
    tags: ["logistics", "resilience"],
    attachments: [],
    amount: 250000,
    currency: "XSGD",
    status: "submitted",
    createdAt: new Date("2026-09-04T00:00:00Z"),
    expiresAt: new Date("2026-12-03T00:00:00Z"),
  }),
  listOpportunityRevisions: async () => [],
}));

vi.mock("../../src/lib/postingAudit.js", () => ({
  anchorPostingAudit: vi.fn(),
  postingAuditReceipt: () => ({ status: "confirmed" }),
  readPostingAudit: mocks.verifyProblem,
}));

vi.mock("../../src/lib/fundingOpportunityAudit.js", () => ({
  anchorFundingOpportunityAudit: vi.fn(),
  fundingOpportunityAuditReceipt: () => ({ status: "confirmed" }),
  readFundingOpportunityAudit: mocks.verifyFunding,
}));

vi.mock("../../src/components/AuditReceipt.jsx", () => ({
  AuditReceipt: ({ eventLabel, actorRole, onVerify }) => (
    <div data-testid="audit-receipt">
      <span>{eventLabel}</span>
      <span>{actorRole}</span>
      <button type="button" onClick={onVerify}>Verify test receipt</button>
    </div>
  ),
}));

const { default: PostingDetailPage } = await import("../../src/pages/PostingDetailPage.jsx");

const pool = (overrides = {}) => ({
  supported: true, problemId: "funding123", tokenSymbol: "USDT", tokenDecimals: 6,
  poolAddress: `0x${"b".repeat(40)}`, tokenAddress: `0x${"c".repeat(40)}`,
  totalDeposited: "25100000000", totalReserved: "0", totalAllocated: "0",
  available: "25100000000", selections: [], canDeposit: true, ...overrides,
});
beforeEach(() => {
  mocks.readPool.mockReset().mockResolvedValue(pool());
  mocks.syncPool.mockReset().mockResolvedValue(pool({ available: "25200000000", totalDeposited: "25200000000" }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("[QCDAO-51] open-funding detail", () => {
  it("renders the distinct fields and verifies with the OpenFunding payload", async () => {
    render(<PostingDetailPage postingId="funding123" onNavigate={() => {}} />);

    expect(await screen.findByRole("heading", { name: "Resilient supply chains" })).toBeTruthy();
    expect(screen.getByText("Open funding opportunity")).toBeTruthy();
    expect(screen.getByText("Fund research into resilient supply chains.")).toBeTruthy();
    expect(screen.getByText("Universities and research organisations may apply.")).toBeTruthy();
    expect(screen.getByText("logistics")).toBeTruthy();
    expect(within(screen.getByTestId("audit-receipt")).getByText("Funder")).toBeTruthy();
    expect(screen.queryByText("Business context")).toBeNull();
    expect(screen.queryByText("Supporting documents")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Verify test receipt" }));
    expect(mocks.verifyFunding).toHaveBeenCalledOnce();
    expect(mocks.verifyProblem).not.toHaveBeenCalled();
  });
});


describe("contract-backed funding available", () => {
  it("uses the same contract balance as the grant panel before opening the funding tab", async () => {
    render(<PostingDetailPage postingId="funding123" onNavigate={() => {}} />);
    const sidebar = () => document.querySelector("aside.context-panel");
    await waitFor(() => expect(sidebar()?.textContent).toContain("USDT 25,100"));
    expect(sidebar().textContent).not.toContain("250,000");
    expect(mocks.readPool).toHaveBeenCalledTimes(1);

    mocks.readPool.mockResolvedValue(pool({ available: "24100000001", totalReserved: "1000000000" }));
    fireEvent.click(screen.getByRole("tab", { name: "Grant funding" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh grant pool" }));
    await waitFor(() => expect(sidebar().textContent).toContain("USDT 24,100.000001"));
  });

  it("updates the sidebar after a deposit is confirmed and synced", async () => {
    render(<PostingDetailPage postingId="funding123" initialTab="funding" onNavigate={() => {}} />);
    const amount = await screen.findByRole("textbox", { name: "Add funding" });
    fireEvent.change(amount, { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Deposit funds" }));
    await waitFor(() => expect(document.querySelector("aside.context-panel").textContent).toContain("USDT 25,200"));
  });

  it("shows zero before a pool exists, and never falls back to the advertised amount on a read failure", async () => {
    mocks.readPool.mockResolvedValue(pool({ poolAddress: null, available: "0", canDeposit: false }));
    render(<PostingDetailPage postingId="funding123" initialTab="funding" onNavigate={() => {}} />);
    await waitFor(() => expect(document.querySelector("aside.context-panel").textContent).toContain("USDT 0"));
    mocks.readPool.mockRejectedValue(new Error("Pool unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh grant pool" }));
    await waitFor(() => expect(document.querySelector("aside.context-panel").textContent).toContain("Balance unavailable"));
    expect(document.querySelector("aside.context-panel").textContent).not.toContain("250,000");
  });
});
