import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyFunding: vi.fn(async () => ({ verified: true })),
  verifyProblem: vi.fn(async () => ({ verified: false })),
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: `0x${"a".repeat(40)}`, isConnected: true }),
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

vi.mock("../../src/components/ConnectWalletModal.jsx", () => ({
  ConnectWalletModal: () => <div role="dialog">Reconnect wallet</div>,
}));

const { default: PostingDetailPage } = await import("../../src/pages/PostingDetailPage.jsx");

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
    expect(screen.getByText("Funder")).toBeTruthy();
    expect(screen.queryByText("Business context")).toBeNull();
    expect(screen.queryByText("Supporting documents")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Verify test receipt" }));
    expect(mocks.verifyFunding).toHaveBeenCalledOnce();
    expect(mocks.verifyProblem).not.toHaveBeenCalled();
  });
});
