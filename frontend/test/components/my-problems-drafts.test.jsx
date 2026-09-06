import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** QCDAO-50 - drafts on the owner's workspace. */

const mocks = vi.hoisted(() => ({ postings: [], deleted: [], deleteShouldFail: false }));

vi.mock("../../src/lib/firebase.js", () => ({
  db: {}, auth: null, functions: null, storage: {},
  isStorageConfigured: true, storageNeedsEmulator: false, app: {},
}));

vi.mock("../../src/lib/postings.js", () => ({
  POSTING_STATUS_DRAFT: "draft",
  listOwnPostings: async () => mocks.postings,
  deletePosting: async (posting) => {
    if (mocks.deleteShouldFail) throw new Error("nope");
    mocks.deleted.push(posting.id);
    mocks.postings = mocks.postings.filter((item) => item.id !== posting.id);
  },
}));

vi.mock("../../src/context/AuthContext.jsx", () => ({
  useAuth: () => ({ user: { id: `0x${"a".repeat(40)}`, org: "SMU" } }),
}));

const { MyProblems } = await import("../../src/components/RoleViews.jsx");

const DRAFT = {
  id: "draft1", status: "draft", title: "Half-written idea",
  attachments: [{ id: "a1", name: "a.pdf", size: 10, contentType: "application/pdf" }],
  updatedAt: new Date("2026-09-01T10:15:00Z"),
};
const UNTITLED = {
  id: "draft2", status: "draft", title: "",
  attachments: [], updatedAt: new Date("2026-09-01T09:00:00Z"),
};
const PUBLISHED = {
  id: "live1", status: "submitted", title: "Cold-chain routing",
  attachments: [], updatedAt: new Date("2026-08-30T08:00:00Z"),
};

beforeEach(() => {
  mocks.postings = [DRAFT, UNTITLED, PUBLISHED];
  mocks.deleted = [];
  mocks.deleteShouldFail = false;
});
afterEach(cleanup);

describe("drafts on the owner's workspace", () => {
  it("[FIT-P50-11] lists drafts separately from published postings", async () => {
    render(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Half-written idea")).toBeTruthy());
    expect(screen.getByText("Cold-chain routing")).toBeTruthy();
  });

  it("[FIT-P50-12] marks every draft with a badge, and nothing else", async () => {
    render(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getAllByText("Draft")).toHaveLength(2));
  });

  it("[FIT-P50-13] labels an untitled draft rather than showing a blank row", async () => {
    render(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Untitled draft")).toBeTruthy());
  });

  it("[FIT-P50-14] shows when each draft was last saved", async () => {
    render(<MyProblems onNavigate={() => {}} />);
    // "Last saved " and the instant are separate text nodes, so match the row.
    await waitFor(() => expect(
      screen.getByText((_, el) => el?.textContent === "Last saved 2026-09-01 10:15:00 UTC"),
    ).toBeTruthy());
  });

  it("[FIT-P50-15] resumes a draft on the create form, not the detail page", async () => {
    const onNavigate = vi.fn();
    render(<MyProblems onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByText("Half-written idea")).toBeTruthy());

    fireEvent.click(screen.getAllByText("Resume editing")[0]);
    expect(onNavigate).toHaveBeenCalledWith("create/draft1");
  });

  it("[FIT-P50-16] opens a published posting on the detail page", async () => {
    const onNavigate = vi.fn();
    render(<MyProblems onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByText("Cold-chain routing")).toBeTruthy());

    fireEvent.click(screen.getByText("View"));
    expect(onNavigate).toHaveBeenCalledWith("posting/live1");
  });

  it("[FIT-P50-17] offers delete on drafts only", async () => {
    render(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Cold-chain routing")).toBeTruthy());
    // Two drafts, one published posting.
    expect(screen.getAllByText("Delete")).toHaveLength(2);
  });

  it("[FIT-P50-18] asks for confirmation before deleting", async () => {
    render(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Half-written idea")).toBeTruthy());

    fireEvent.click(screen.getAllByText("Delete")[0]);
    expect(screen.getByText("Delete this draft?")).toBeTruthy();
    // Nothing is removed until the dialog is confirmed.
    expect(mocks.deleted).toEqual([]);
  });

  it("[FIT-P50-19] keeps the draft when the dialog is dismissed", async () => {
    render(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Half-written idea")).toBeTruthy());

    fireEvent.click(screen.getAllByText("Delete")[0]);
    fireEvent.click(screen.getByText("Keep it"));

    await waitFor(() => expect(screen.queryByText("Delete this draft?")).toBeNull());
    expect(mocks.deleted).toEqual([]);
    expect(screen.getByText("Half-written idea")).toBeTruthy();
  });

  it("[FIT-P50-20] deletes only once confirmed, then refreshes the list", async () => {
    render(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Half-written idea")).toBeTruthy());

    fireEvent.click(screen.getAllByText("Delete")[0]);
    fireEvent.click(screen.getByText("Delete draft"));

    await waitFor(() => expect(mocks.deleted).toEqual(["draft1"]));
    await waitFor(() => expect(screen.queryByText("Half-written idea")).toBeNull());
  });

  it("[FIT-P50-21] tells the owner when there are no drafts yet", async () => {
    mocks.postings = [PUBLISHED];
    render(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no drafts/i)).toBeTruthy());
  });
});
