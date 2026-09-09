import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("firebase/functions", () => ({ httpsCallable: (_functions, name) => (data) => mocks.call(name, data) }));
vi.mock("../../src/lib/firebase.js", () => ({ functions: {} }));
vi.mock("../../src/lib/postingAudit.js", () => ({
  postingAuditReceipt: (record) => record.audit,
  readPostingAudit: async () => ({
    verified: true,
    anchor: { anchor: { timestamp: 1_756_800_000n, actor: `0x${"a".repeat(40)}` } },
  }),
}));
vi.mock("../../src/lib/fundingOpportunityAudit.js", () => ({
  fundingOpportunityAuditReceipt: (record) => record.audit,
  readFundingOpportunityAudit: async () => ({ verified: false }),
}));
import { ProposalAuditQueue } from "../../src/components/ProposalAuditQueue.jsx";
afterEach(cleanup);
const HASH = `0x${"4".repeat(64)}`;
const TX = `0x${"3".repeat(64)}`;
const opportunity = {
  id: "audit-parent",
  title: "Campus cooling",
  opportunityType: null,
  organisation: "SMU",
  status: "submitted",
  summary: "Reduce cooling cost",
  audit: { schemaVersion: 1, status: "pending", transactionHash: TX, contentHash: HASH },
};
const item = {
  id: "proposal1",
  title: "Quantum routing",
  status: "failed",
  attemptCount: 3,
  transactionHash: TX,
  updatedAt: "2026-09-06T10:00:00Z",
  nextAttemptAt: "2026-09-06T10:01:00Z",
  audit: { schemaVersion: 1, status: "failed", attemptCount: 3, transactionHash: TX, contentHash: HASH },
  opportunity,
};
beforeEach(() => mocks.call.mockReset());
it("shows the queue, expands a receipt, detects mismatch, and retries confirmation", async () => {
  mocks.call.mockImplementation(async (name) => ({ data: name === "adminListProposalAudits" ? { items: [item], cursor: null }
    : name === "adminVerifyProposalAudit" ? { verified: false } : { message: "Verification confirmed and receipt saved." } }));
  render(<ProposalAuditQueue />);
  expect(await screen.findByText("Quantum routing")).toBeTruthy();
  expect(screen.getByText(/Responds to/)).toBeTruthy();
  expect(screen.getByText(/Campus cooling/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View receipt" }));
  expect(await screen.findByText(/Mismatch detected/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry confirmation" }));
  expect(await screen.findByText("Verification confirmed and receipt saved.")).toBeTruthy();
  expect(mocks.call).toHaveBeenCalledWith("adminRetryProposalAudit", { proposalId: "proposal1" });
});
it("expands the parent listing audit receipt", async () => {
  mocks.call.mockResolvedValue({ data: { items: [item], cursor: null } });
  render(<ProposalAuditQueue />);
  fireEvent.click(await screen.findByRole("button", { name: "View listing receipt" }));
  expect((await screen.findAllByText("Funded problem statement submitted")).length).toBeGreaterThan(0);
  expect(screen.getAllByText("problems/audit-parent").length).toBeGreaterThan(0);
});
it("explains when the parent listing is missing", async () => {
  mocks.call.mockResolvedValue({ data: { items: [{ ...item, opportunity: null }], cursor: null } });
  render(<ProposalAuditQueue />);
  expect(await screen.findByText("Parent listing is no longer available.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "View listing receipt" })).toBeNull();
});
it("shows retryable loading errors and the empty state after refresh", async () => {
  mocks.call.mockRejectedValueOnce(new Error("Network unavailable")).mockResolvedValue({ data: { items: [], cursor: null } });
  render(<ProposalAuditQueue />);
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh queue" }));
  expect(await screen.findByText("No proposal verification jobs yet.")).toBeTruthy();
});
it("preserves the queue and explains a failed admin retry", async () => {
  mocks.call.mockImplementation(async (name) => {
    if (name === "adminRetryProposalAudit") throw new Error("Transaction still pending. Proposal saved.");
    return { data: { items: [item], cursor: null } };
  });
  render(<ProposalAuditQueue />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry confirmation" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Proposal saved");
  expect(screen.getByText("Quantum routing")).toBeTruthy();
});
