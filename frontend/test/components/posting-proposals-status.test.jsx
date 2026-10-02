import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({ items: [] }));
vi.mock("../../src/lib/proposals.js", () => ({
  PROPOSAL_STATUS_DRAFT: "draft",
  listProposalsForPosting: async () => rows.items,
}));
vi.mock("wagmi", async (importOriginal) => ({
  ...await importOriginal(),
  useAccount: () => ({ isConnected: false, address: null, chainId: null }),
}));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: { id: "0xabc" } }) }));
import { PostingProposals } from "../../src/components/PostingProposals.jsx";

afterEach(cleanup);

it("[FUT-ACM-193] shows a removed proposal as its reason and a claim button", async () => {
  rows.items = [{ id: "p1", removed: true, title: "Routing study", reason: "off_topic", details: "The result does not match the source.", claimFunds: true, summary: "Secret summary" }];
  render(<PostingProposals posting={{ id: "post1", matching: { status: "open" } }} viewerId="0xabc" proposalCount={1} onNavigate={vi.fn()} />);
  expect(await screen.findByRole("heading", { level: 2, name: "Proposals" })).toBeTruthy();
  expect(screen.getByText("Routing study")).toBeTruthy();
  expect(screen.getByText("Removed due to: Off topic — The result does not match the source.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Claim funds" })).toBeTruthy();
  expect(screen.queryByText("Secret summary")).toBeNull();
  expect(screen.queryByRole("button", { name: "View proposal" })).toBeNull();
});

it("shows a proposal's funding state as a pill, with the consequence as a note", async () => {
  rows.items = [{ id: "p1", title: "Proposal A", status: "submitted", currency: "USDT", amount: 9972, createdAt: new Date(),
    matching: { status: "declined" } }];
  render(<PostingProposals posting={{ id: "post1", matching: { status: "open" } }} viewerId="0xabc" proposalCount={1} onNavigate={vi.fn()} />);
  // QCDAO-91: the shared status badge, with the refund as a note.
  const pill = await screen.findByText("Declined");
  expect(pill.closest(".workflow-badge").className).toContain("tone-danger");
  expect(screen.getByText("Funders refunded")).toBeTruthy();
  expect(screen.getByText("USDT 9,972", { exact: false })).toBeTruthy();
  expect(screen.queryByText(/Rejected ·/)).toBeNull();
});
