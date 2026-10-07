import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), comment: vi.fn() }));

vi.mock("../../src/lib/auditTrail.js", () => ({ listAuditTrail: (...args) => mocks.list(...args) }));
vi.mock("../../src/lib/proposals.js", () => ({ findProposal: async () => ({ id: "proposal-1", title: "Cold chain" }) }));
vi.mock("../../src/components/RelatedAuditReceiptPane.jsx", () => ({
  RELATED_AUDIT_KIND: { PROPOSAL: "proposal", LISTING: "listing", COMMENT: "comment" },
  RelatedAuditReceiptPane: () => <div>Receipt open</div>,
}));

import { ConsolidatedAuditTrail } from "../../src/components/ConsolidatedAuditTrail.jsx";

const recommendation = {
  id: "comment_comment-1",
  eventType: "evaluator_recommendation",
  types: ["evaluator_recommendation"],
  label: "Evaluator recommendation submitted",
  description: "Evaluator recommendation: Recommend with revisions. Stored as a Firestore comment. This is not verified on-chain.",
  at: "2026-09-10T00:00:00.000Z",
  actorRole: "evaluator",
  actorLabel: "Evaluator",
  entityType: "proposal",
  entityId: "proposal-1",
  entityLabel: "Cold chain",
  problemId: "problem-1",
  proposalId: "proposal-1",
  verification: "off_chain",
  verificationLabel: "Off-chain record",
  offChain: true,
  receiptKind: null,
  commentId: "comment-1",
  recommendation: "recommend_with_revisions",
  recommendationLabel: "Recommend with revisions",
  badge: "evaluator",
  workflowStatus: null,
};

beforeEach(() => {
  mocks.list.mockReset();
  mocks.comment.mockReset();
  window.location.hash = "#/proposal/proposal-1?auditTypes=evaluator_recommendation&auditRole=evaluator";
});
afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("QCDAO-96 and QCDAO-97 audit trail filters", () => {
  it("reads combined filters from the URL, shows the count, and clears them in one action", async () => {
    mocks.list.mockResolvedValue({ items: [recommendation], count: 1, nextCursor: null, truncated: false });
    render(<ConsolidatedAuditTrail scope="proposal" entityId="proposal-1" onOpenComment={mocks.comment} />);

    expect(await screen.findByRole("heading", { name: "Evaluator recommendation submitted" })).toBeTruthy();
    expect(screen.getByText("1 event")).toBeTruthy();
    expect(document.querySelector(".audit-trail-verify").textContent).toBe("Off-chain record");
    expect(screen.getByText("Evaluator · Recommend with revisions")).toBeTruthy();
    expect(screen.getAllByText(/not verified on-chain/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/criterion|weighted score|qft/i)).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Evaluator recommendation" }).checked).toBe(true);
    expect(screen.getByLabelText("Actor role").value).toBe("evaluator");
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({
      entityType: "proposal",
      entityId: "proposal-1",
      eventTypes: ["evaluator_recommendation"],
      actorRole: "evaluator",
    }));

    fireEvent.click(screen.getByRole("button", { name: "View comment" }));
    expect(mocks.comment).toHaveBeenCalledWith(expect.objectContaining({ commentId: "comment-1" }));
    expect(document.getElementById("audit-trail-comment_comment-1").classList.contains("is-referenced")).toBe(true);

    mocks.list.mockResolvedValue({ items: [], count: 0, nextCursor: null, truncated: false });
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByRole("heading", { name: "No workflow events yet" })).toBeTruthy();
    expect(screen.getByText("0 events")).toBeTruthy();
    expect(window.location.hash.includes("auditTypes")).toBe(false);
    expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ eventTypes: [], entityId: "proposal-1" }));
  });

  it("shows a distinct empty state when filters match nothing", async () => {
    mocks.list.mockResolvedValue({ items: [], count: 0, nextCursor: null, truncated: false });
    window.location.hash = "#/admin?auditTypes=moderation&auditFrom=2026-09-01&auditTo=2026-09-02&auditVerify=anchored&auditEntity=problem-1";
    render(<ConsolidatedAuditTrail scope="admin" />);
    expect(await screen.findByRole("heading", { name: "No events match these filters" })).toBeTruthy();
    expect(screen.getByText("0 events")).toBeTruthy();
    expect(screen.getByLabelText("From").value).toBe("2026-09-01");
    expect(screen.getByLabelText("Verification").value).toBe("anchored");
    expect(screen.getByLabelText("Related record").value).toBe("problem-1");
  });
});

const token = "0x" + "1".repeat(40);
const contributor = "0x" + "2".repeat(40);
const escrow = "0x" + "3".repeat(40);
const transactionHash = "0x" + "4".repeat(64);
const fundingEvent = (overrides = {}) => ({
  id: "audit_escrow-deposit", eventType: "funding_status", types: ["funding_status"],
  label: "Escrow deposit confirmed", description: "A confirmed escrow deposit is anchored on Arbitrum Sepolia.",
  at: "2026-10-07T00:00:00.000Z", actorRole: "funder", actorLabel: "Private contributor",
  entityType: "proposal", entityId: "proposal-1", entityLabel: "Cold chain",
  problemId: "problem-1", proposalId: "proposal-1", verification: "anchored",
  verificationLabel: "Anchored on-chain", receiptKind: "proposal",
  funding: {
    eventType: "Deposit", amountBaseUnits: "12500000", tokenAddress: token, tokenSymbol: "QFT", tokenDecimals: 6,
    actorAddress: null, actorLabel: "Private contributor", counterpartyAddress: escrow, counterpartyLabel: "Escrow contract",
    transactionHash, blockNumber: 316000000, chainId: 421614, ...overrides,
  },
});

describe("QCDAO-117 consolidated escrow details", () => {
  const show = (item, scope = "proposal") => {
    window.location.hash = "#/proposal/proposal-1";
    mocks.list.mockResolvedValue({ items: [item], count: 1, nextCursor: null, truncated: false });
    render(<ConsolidatedAuditTrail scope={scope} entityId="proposal-1" />);
    return screen.findByRole("heading", { name: item.label });
  };

  it("shows exact amount, token, masked actor, counterparty, block and the funding transaction reference", async () => {
    await show(fundingEvent());
    const details = within(document.querySelector('[aria-label="Escrow event details"]'));
    expect(details.getByText("12.5 QFT")).toBeTruthy();
    expect(details.getByText(token)).toBeTruthy();
    expect(details.getByText("Private contributor")).toBeTruthy();
    expect(details.getByText("Escrow contract")).toBeTruthy();
    expect(details.getByText(escrow)).toBeTruthy();
    expect(details.getByText("316000000")).toBeTruthy();
    expect(details.getByText(transactionHash)).toBeTruthy();
    expect(details.getByRole("link", { name: "View escrow transaction" }).getAttribute("href"))
      .toBe("https://sepolia.arbiscan.io/tx/" + transactionHash);
    expect(document.body.textContent).not.toContain(contributor);
    fireEvent.click(screen.getByRole("checkbox", { name: "Funding status change" }));
    expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ eventTypes: ["funding_status"] }));
  });

  it("preserves large fractional values and shows the full actor received in an administrator response", async () => {
    await show(fundingEvent({ amountBaseUnits: "12345678901234567890123456", tokenDecimals: 18,
      actorAddress: contributor, actorLabel: "Administrator-visible contributor" }), "admin");
    const details = within(document.querySelector('[aria-label="Escrow event details"]'));
    expect(details.getByText("12345678.901234567890123456 QFT")).toBeTruthy();
    expect(details.getByText(contributor)).toBeTruthy();
  });

  it("supports zero-decimal tokens and a zero-valued transfer without losing block zero", async () => {
    await show(fundingEvent({ amountBaseUnits: "0", tokenDecimals: 0, blockNumber: 0 }));
    const details = within(document.querySelector('[aria-label="Escrow event details"]'));
    expect(details.getByText("0 QFT")).toBeTruthy();
    expect(details.getByText("0", { exact: true })).toBeTruthy();
  });

  it.each(["SelectionLocked", "Cancelled", "Expired"])("does not fabricate a payment for %s", async eventType => {
    await show(fundingEvent({ eventType, amountBaseUnits: null, counterpartyAddress: null, counterpartyLabel: "Unavailable" }));
    const details = within(document.querySelector('[aria-label="Escrow event details"]'));
    expect(details.getAllByText("Not applicable")).toHaveLength(2);
    expect(details.queryByText("0 QFT")).toBeNull();
  });

  it("shows missing historical metadata explicitly and raw units when decimals are unavailable", async () => {
    await show(fundingEvent({ amountBaseUnits: "12500000", tokenDecimals: null, tokenSymbol: null, tokenAddress: null }));
    const details = within(document.querySelector('[aria-label="Escrow event details"]'));
    expect(details.getByText("12500000 base units")).toBeTruthy();
    expect(details.getByText("Not recorded")).toBeTruthy();
    expect(details.queryByText("12.5 QFT")).toBeNull();
  });

  it("keeps a refund recipient masked and does not fabricate transfer data for legacy rows", async () => {
    await show(fundingEvent({ eventType: "RefundClaimed", amountBaseUnits: null, tokenDecimals: null,
      counterpartyAddress: null, counterpartyLabel: "Private contributor" }));
    const details = within(document.querySelector('[aria-label="Escrow event details"]'));
    expect(details.getAllByText("Private contributor")).toHaveLength(2);
    expect(details.getByText("Not recorded")).toBeTruthy();
    expect(document.body.textContent).not.toContain(contributor);
  });

  it("does not link a different chain's transaction to the Sepolia explorer", async () => {
    await show(fundingEvent({ chainId: 1 }));
    expect(screen.getByText(transactionHash)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "View escrow transaction" })).toBeNull();
  });

  it("keeps an unknown historical event inconclusive when transfer metadata is missing", async () => {
    await show(fundingEvent({ eventType: "LegacyEscrowEvent", amountBaseUnits: null,
      counterpartyAddress: null, counterpartyLabel: "Unavailable" }));
    const details = within(document.querySelector('[aria-label="Escrow event details"]'));
    expect(details.getAllByText("Not recorded")).toHaveLength(2);
    expect(details.queryByText("Not applicable")).toBeNull();
  });
});
