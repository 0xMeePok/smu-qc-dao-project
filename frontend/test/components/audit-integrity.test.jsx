import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ server: null, getServer: vi.fn(), getCached: vi.fn() }));
vi.mock("../../src/lib/firebase.js", () => ({ db: {}, functions: null }));
vi.mock("../../src/lib/authFlow.js", () => ({ requireFirebase: vi.fn() }));
vi.mock("firebase/firestore", async (original) => ({
  ...await original(),
  doc: (_db, collection, id) => ({ collection, id }),
  getDocFromServer: (...args) => mocks.getServer(...args),
  getDoc: (...args) => mocks.getCached(...args),
}));

import { AuditReceipt } from "../../src/components/AuditReceipt.jsx";
import { preparePostingAudit, postingAuditReceipt, readPostingAudit } from "../../src/lib/postingAudit.js";
import { prepareFundingOpportunityAudit, fundingOpportunityAuditReceipt, readFundingOpportunityAudit } from "../../src/lib/fundingOpportunityAudit.js";
import { proposalAuditReceipt, readProposalAudit } from "../../src/lib/proposalAudit.js";
import { prepareStoredProposal } from "../../../firebase/functions/proposalAuditPayload.js";

const account = `0x${"a".repeat(40)}`;
const base = {
  id: "integrity123", ownerId: account, researcherId: account, problemId: "problem123",
  title: "Original title", summary: "Original summary", methodology: "Original method",
  fundingThesis: "Original thesis", amount: 1200, currency: "USDC", attachments: [],
  expiresAt: new Date("2026-12-01T00:00:00Z"),
  audit: { schemaVersion: 1, status: "confirmed", transactionHash: `0x${"3".repeat(64)}` },
};
const cases = [
  { name: "problem", prepare: (r) => preparePostingAudit(r).prepared, receipt: postingAuditReceipt, read: readPostingAudit, fields: ["title", "summary", "amount"] },
  { name: "open funding", prepare: (r) => prepareFundingOpportunityAudit(r).prepared, receipt: fundingOpportunityAuditReceipt, read: readFundingOpportunityAudit, fields: ["title", "fundingThesis", "amount"] },
  { name: "proposal", prepare: prepareStoredProposal, receipt: proposalAuditReceipt, read: readProposalAudit, fields: ["title", "summary", "methodology", "amount"] },
];

function adaptersFor(prepared) {
  return { readContract: vi.fn(async ({ functionName }) => {
    if (functionName === "getOpportunity") return {
      owner: account, kind: prepared.args[1], contentHash: prepared.contentHash, expiresAt: prepared.args[3],
    };
    if (functionName === "getProposal") return {
      researcher: account, opportunityId: prepared.opportunityId, opportunityRevisionIndex: 0,
      proposalHash: prepared.proposalHash, solutionHash: prepared.solutionHash,
    };
    if (functionName === "anchorCount") return 1n;
    if (functionName === "anchorAt") return { contentHash: prepared.anchorHash };
    throw new Error(`Unexpected read: ${functionName}`);
  }), writeContract: vi.fn(), waitForTransactionReceipt: vi.fn() };
}

beforeEach(() => {
  mocks.server = { ...base };
  mocks.getServer.mockReset().mockImplementation(async ({ id }) => ({
    id, exists: () => Boolean(mocks.server), data: () => mocks.server,
  }));
  mocks.getCached.mockReset().mockImplementation(async ({ id, collection }) => ({
    id, exists: () => collection !== "opportunityMetrics", data: () => base,
  }));
});
afterEach(cleanup);

for (const flow of cases) {
  for (const field of flow.fields) {
    it(`${flow.name}: recheck detects backend ${field} edits while receipt and page remain unchanged`, async () => {
      const original = flow.prepare(base);
      const audit = { ...flow.receipt(base), contentHash: original.contentHash };
      mocks.server = { ...base, audit };
      const adapters = adaptersFor(original);
      render(<AuditReceipt audit={audit} eventLabel="Submission" onVerify={() => flow.read(base, { adapters })} />);
      expect(await screen.findByText("Verified on Arbitrum Sepolia")).toBeTruthy();

      mocks.server = { ...mocks.server, [field]: field === "amount" ? 9999 : "Edited in backend" };
      fireEvent.click(screen.getByRole("button", { name: /check again/i }));
      expect(screen.queryByText(/Verified match/)).toBeNull();
      expect(await screen.findByText("On-chain mismatch")).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toContain("Mismatch detected");
      expect(screen.getByText(flow.prepare(mocks.server).contentHash)).toBeTruthy();
      expect(mocks.getServer).toHaveBeenCalledTimes(2);
      expect(mocks.getCached.mock.calls.every(([ref]) => ref.collection === "opportunityMetrics")).toBe(true);
      expect(adapters.writeContract).not.toHaveBeenCalled();
    });
  }

  it(`${flow.name}: a failed server recheck clears the previous green result`, async () => {
    const adapters = adaptersFor(flow.prepare(base));
    render(<AuditReceipt audit={flow.receipt(base)} eventLabel="Submission" onVerify={() => flow.read(base, { adapters })} />);
    expect(await screen.findByText("Verified on Arbitrum Sepolia")).toBeTruthy();
    mocks.getServer.mockRejectedValueOnce(new Error("Server unavailable"));
    fireEvent.click(screen.getByRole("button", { name: /check again/i }));
    expect(await screen.findByText(/Unable to verify right now/)).toBeTruthy();
    expect(screen.queryByText("Server unavailable")).toBeNull();
    expect(screen.queryByText("Verified on Arbitrum Sepolia")).toBeNull();
    expect(screen.queryByText(/Verified match/)).toBeNull();
  });

  it(`${flow.name}: a deleted server document never falls back to cached content`, async () => {
    mocks.server = null;
    await expect(flow.read(base, { adapters: adaptersFor(flow.prepare(base)) })).rejects.toThrow(/no longer available/);
  });
}

it("does not retain a green message while a new check is still pending", async () => {
  let finish;
  const verify = vi.fn().mockResolvedValueOnce({ verified: true })
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<AuditReceipt audit={base.audit} eventLabel="Submission" onVerify={verify} />);
  expect(await screen.findByText(/Verified match/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /check again/i }));
  expect(screen.queryByText(/Verified match/)).toBeNull();
  expect(screen.getByText("Reading AuditRegistry")).toBeTruthy();
  await act(async () => { finish({ verified: false }); });
  expect(screen.getByText("On-chain mismatch")).toBeTruthy();
});
