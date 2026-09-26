import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QCDAO-58 - downloading a PDF from a posting somebody else published.
 *
 * The path is built from the POSTING's owner, never the viewer's wallet. Getting
 * that wrong produces a 403 that looks like a rules problem, which is exactly how
 * this broke in production, so the owner passed to downloadAttachment is asserted
 * explicitly rather than inferred from "no error appeared".
 */

const OWNER = `0x${"8".repeat(40)}`;
const VIEWER = `0x${"9".repeat(40)}`;

const mocks = vi.hoisted(() => ({
  downloadArgs: [],
  saved: [],
  downloadShouldFail: null,
  posting: null,
  user: null,
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: VIEWER, isConnected: true }),
}));
// Builds a real wagmi config at import time, which the bare wagmi mock breaks.
vi.mock("../../src/lib/wagmi.js", () => ({
  wagmiConfig: {},
  isUsableConnector: () => true,
}));
vi.mock("../../src/lib/firebase.js", () => ({
  db: {}, auth: null, functions: null, storage: {},
  isStorageConfigured: true, storageNeedsEmulator: false, app: {},
}));
vi.mock("../../src/lib/postings.js", () => ({
  findPosting: async () => mocks.posting,
  listOpportunityRevisions: async () => [],
}));
vi.mock("../../src/lib/attachments.js", () => ({
  formatBytes: (n) => `${n} B`,
  messageForStorageError: (error) => error?.message ?? "download failed",
  downloadAttachment: async (args) => {
    mocks.downloadArgs.push(args);
    if (mocks.downloadShouldFail) throw mocks.downloadShouldFail;
    return new Blob(["%PDF-1.7"], { type: "application/pdf" });
  },
  saveBlobAs: (blob, name) => { mocks.saved.push({ blob, name }); },
}));
vi.mock("../../src/lib/postingAudit.js", () => ({
  postingAuditReceipt: () => null,
  readPostingAudit: async () => ({ verified: true }),
  anchorPostingAudit: async () => ({ status: "confirmed" }),
}));
vi.mock("../../src/components/ConnectWalletModal.jsx", () => ({
  ConnectWalletModal: () => <div role="dialog">Reconnect wallet</div>,
}));
vi.mock("../../src/context/AuthContext.jsx", () => ({
  useAuth: () => ({ isAuthenticated: true, user: mocks.user }),
}));
vi.mock("../../src/components/MatchingPanel.jsx", () => ({
  MatchingPanel: ({ onNavigate }) => <section id="proposal-funding"><button onClick={() => onNavigate("proposal/proposal1")}>View funded proposal</button></section>,
}));
vi.mock("../../src/components/ProposalComparison.jsx", () => ({
  ProposalComparison: () => <section id="proposal-comparison" />,
}));

const { default: PostingDetailPage } = await import("../../src/pages/PostingDetailPage.jsx");

const ATTACHMENT = { id: "att0001x", name: "spec.pdf", size: 2048, contentType: "application/pdf" };

function publishedPosting(overrides = {}) {
  return {
    id: "posting777",
    ownerId: OWNER,
    organisation: "Meridian Logistics",
    title: "Cold-chain route optimisation",
    summary: "Routing degrades under demand spikes.",
    status: "submitted",
    categories: ["ai"],
    amount: 80000,
    currency: "SGD",
    attachments: [ATTACHMENT],
    createdAt: new Date("2026-09-01T10:00:00Z"),
    expiresAt: new Date("2026-12-01T00:00:00Z"),
    ...overrides,
  };
}

const downloadButton = () => screen.getByRole("button", { name: /^download$/i });

beforeEach(() => {
  mocks.downloadArgs = [];
  mocks.saved = [];
  mocks.downloadShouldFail = null;
  mocks.posting = publishedPosting();
  mocks.user = { id: VIEWER };
});
afterEach(cleanup);

describe("downloading an attachment from someone else's posting", () => {
  it("[FIT-OPD-201] shows the attachment on a posting the viewer does not own", async () => {
    render(<PostingDetailPage postingId="posting777" onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("spec.pdf")).toBeTruthy());
    expect(downloadButton()).toBeTruthy();
  });

  it("[FIT-OPD-202] downloads using the POSTING's owner, not the viewer's wallet", async () => {
    render(<PostingDetailPage postingId="posting777" onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("spec.pdf")).toBeTruthy());

    await act(async () => { fireEvent.click(downloadButton()); });

    expect(mocks.downloadArgs).toHaveLength(1);
    // The storage path is problems/{postingOwner}/{postingId}/{attachmentId}.pdf.
    // Passing the viewer here builds a path nobody owns and Storage returns 403.
    expect(mocks.downloadArgs[0].ownerId).toBe(OWNER);
    expect(mocks.downloadArgs[0].ownerId).not.toBe(VIEWER);
    expect(mocks.downloadArgs[0].problemId).toBe("posting777");
    expect(mocks.downloadArgs[0].attachment.id).toBe(ATTACHMENT.id);
  });

  it("[FIT-OPD-203] hands the downloaded blob to the browser under its display name", async () => {
    render(<PostingDetailPage postingId="posting777" onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("spec.pdf")).toBeTruthy());

    await act(async () => { fireEvent.click(downloadButton()); });

    expect(mocks.saved).toHaveLength(1);
    expect(mocks.saved[0].name).toBe("spec.pdf");
    expect(mocks.saved[0].blob).toBeInstanceOf(Blob);
  });

  it("[FIT-OPD-204] reports a refused download instead of failing silently", async () => {
    const refusal = new Error("You do not have permission to use this file.");
    refusal.code = "storage/unauthorized";
    mocks.downloadShouldFail = refusal;
    render(<PostingDetailPage postingId="posting777" onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("spec.pdf")).toBeTruthy());

    await act(async () => { fireEvent.click(downloadButton()); });

    expect(mocks.saved).toHaveLength(0);
    await waitFor(() => expect(
      screen.getAllByRole("alert").some((node) => /permission/i.test(node.textContent)),
    ).toBe(true));
  });
});

describe("proposal funding on a problem detail page", () => {
  it("shows the creator deadline while pending and a closed label once matched", async () => {
    const expiresAt = new Date("2026-12-01T00:00:00Z");
    const deadlineAt = new Date("2026-11-01T00:00:00Z");
    mocks.posting = publishedPosting({ expiresAt, matching: { status: "awaiting_confirmation", deadlineAt } });
    const { unmount } = render(<PostingDetailPage postingId="posting777" onNavigate={() => {}} />);
    await screen.findByText("Creator response window");
    expect(screen.getAllByText("Awaiting creator acceptance").length).toBeGreaterThan(0);
    expect(screen.getByText("2026-11-01 00:00:00 UTC")).toBeTruthy();
    unmount();

    mocks.posting = publishedPosting({ expiresAt, matching: { status: "open", reopenedAt: new Date("2026-10-01T00:00:00Z") } });
    const reopened = render(<PostingDetailPage postingId="posting777" onNavigate={() => {}} />);
    await screen.findByText("Time remaining");
    expect(screen.getByLabelText(/Closes 2026-12-01 00:00:00 UTC/)).toBeTruthy();
    expect(screen.queryByText("Creator response window")).toBeNull();
    reopened.unmount();

    mocks.posting = publishedPosting({ expiresAt, matching: { status: "confirmed", confirmedAt: new Date("2026-11-02T00:00:00Z") } });
    render(<PostingDetailPage postingId="posting777" onNavigate={() => {}} />);
    await screen.findByText("Closed");
    expect(screen.getByLabelText("Match confirmed at 2026-11-02 00:00:00 UTC.")).toBeTruthy();
    expect(screen.queryByText("Time remaining")).toBeNull();
  });

  it("shows an indicative proposal budget instead of claiming the problem has been funded", async () => {
    mocks.posting = publishedPosting({ fundedAmount: 40000, fundingProgressPercent: 50 });
    mocks.user = { id: VIEWER, roles: ["funder"] };
    render(<PostingDetailPage postingId="posting777" onNavigate={() => {}} />);
    await screen.findByText("Indicative proposal budget");
    expect(screen.getByText("SGD 80,000")).toBeTruthy();
    expect(screen.queryByText(/50% funded|committed of|Funded business problem/)).toBeNull();
    expect(screen.getByRole("button", { name: "View proposals to fund" })).toBeTruthy();
  });

  it("[FUT-SPE-165] takes the owner to the proposal comparison", async () => {
    mocks.user = { id: OWNER, roles: ["owner"] };
    const onNavigate = vi.fn();
    render(<PostingDetailPage postingId="posting777" onNavigate={onNavigate} />);
    const review = await screen.findByRole("button", { name: "Review proposals" });
    const panel = document.getElementById("proposal-comparison");
    panel.scrollIntoView = vi.fn();
    fireEvent.click(review);
    expect(panel.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    fireEvent.click(screen.getByRole("button", { name: "View funded proposal" }));
    expect(onNavigate).toHaveBeenCalledWith("proposal/proposal1");
  });

  it("groups the posting into tabs, one job at a time", async () => {
    mocks.user = { id: OWNER, roles: ["owner"] };
    mocks.posting = publishedPosting({ proposalCount: 2, businessContext: "Perishable deliveries." });
    render(<PostingDetailPage postingId="posting777" onNavigate={() => {}} />);
    const overview = await screen.findByRole("tab", { name: "Overview" });
    expect(overview.getAttribute("aria-selected")).toBe("true");
    // The brief's fields sit together under one heading, not one card each.
    const problem = screen.getByRole("heading", { name: "The problem" }).closest(".detail-group");
    expect(problem.textContent).toContain("Routing degrades under demand spikes.");
    expect(problem.textContent).toContain("Perishable deliveries.");
    expect(screen.getByRole("tab", { name: "Proposals (2)" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Discussion" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Record" }));
    expect(screen.getByRole("tab", { name: "Record" }).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("posting-panel-record").className).toContain("is-active");
    expect(document.getElementById("posting-panel-overview").className).not.toContain("is-active");
    expect(document.getElementById("posting-panel-record").textContent).toContain("posting777");

    // An in-page action opens the tab that holds its section.
    const panel = document.getElementById("proposal-comparison");
    panel.scrollIntoView = vi.fn();
    fireEvent.click(screen.getByRole("button", { name: "Review proposals" }));
    expect(screen.getByRole("tab", { name: "Proposals (2)" }).getAttribute("aria-selected")).toBe("true");
    expect(panel.scrollIntoView).toHaveBeenCalled();
  });
});

