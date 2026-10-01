import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
