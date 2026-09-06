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
  useAuth: () => ({ isAuthenticated: true, user: { id: VIEWER } }),
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
