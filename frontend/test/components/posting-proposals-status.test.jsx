import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({ items: [] }));
vi.mock("../../src/lib/proposals.js", () => ({
  PROPOSAL_STATUS_DRAFT: "draft",
  listProposalsForPosting: async () => rows.items,
}));
import { PostingProposals } from "../../src/components/PostingProposals.jsx";

afterEach(cleanup);

it("shows a proposal's funding state as a pill, with the consequence as a note", async () => {
  rows.items = [{ id: "p1", title: "Proposal A", status: "submitted", currency: "USDT", amount: 9972, createdAt: new Date(),
    matching: { status: "declined" } }];
  render(<PostingProposals posting={{ id: "post1", matching: { status: "open" } }} viewerId="0xabc" proposalCount={1} onNavigate={vi.fn()} />);
  const pill = await screen.findByText("Declined");
  expect(pill.className).toContain("funding-pill");
  expect(screen.getByText("USDT 9,972", { exact: false })).toBeTruthy();
  expect(screen.queryByText(/Rejected ·/)).toBeNull();
});
