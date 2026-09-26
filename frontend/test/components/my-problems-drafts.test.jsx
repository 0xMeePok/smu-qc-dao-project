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
  listOwnPostings: async (_owner, { cursor = 0 } = {}) => ({
    items: mocks.postings.slice(cursor || 0, (cursor || 0) + 50),
    cursor: (cursor || 0) + 50, hasMore: mocks.postings.length > (cursor || 0) + 50,
  }),
  deletePosting: async (posting) => {
    if (mocks.deleteShouldFail) throw new Error("nope");
    mocks.deleted.push(posting.id);
    mocks.postings = mocks.postings.filter((item) => item.id !== posting.id);
  },
}));

vi.mock("../../src/context/AuthContext.jsx", () => ({
  useAuth: () => ({ user: { id: `0x${"a".repeat(40)}`, org: "SMU" } }),
}));
vi.mock("../../src/components/RelatedAuditReceiptPane.jsx", () => ({
  RELATED_AUDIT_KIND: { PROPOSAL: "proposal", LISTING: "listing", COMMENT: "comment" },
  RelatedAuditReceiptPane: () => null,
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

  it("opens a published posting on the edit form", async () => {
    const onNavigate = vi.fn();
    render(<MyProblems onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByText("Cold-chain routing")).toBeTruthy());
    fireEvent.click(screen.getByText("Edit"));
    expect(onNavigate).toHaveBeenCalledWith("edit-posting/live1");
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


it("QCDAO-132 can load and resume a draft older than the first 50 postings", async () => {
  mocks.postings = [...Array.from({ length: 50 }, (_, i) => ({ ...PUBLISHED, id: `p${i}`, title: `Published ${i}` })), DRAFT];
  const onNavigate = vi.fn();
  render(<MyProblems onNavigate={onNavigate} />);
  await screen.findByRole("button", { name: "Load older opportunities" });
  expect(screen.queryByText(DRAFT.title)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load older opportunities" }));
  await screen.findByText(DRAFT.title);
  fireEvent.click(screen.getByRole("button", { name: "Resume editing" }));
  expect(onNavigate).toHaveBeenCalledWith("create/draft1");
  expect(screen.queryByRole("button", { name: "Load older opportunities" })).toBeNull();
});

/** QCDAO-62/63 - the researcher's tracking list and the evaluator's queue. */
const queues = vi.hoisted(() => ({ mine: { items: [] }, drafts: [], evaluator: async () => ({ items: [], nextCursor: null }), navigated: [] }));

vi.mock("../../src/lib/proposalQueues.js", async (importOriginal) => ({
  ...(await importOriginal()),
  listMyProposalQueue: async () => queues.mine,
  listEvaluatorQueue: async (payload) => queues.evaluator(payload),
}));

vi.mock("../../src/lib/proposals.js", async (importOriginal) => ({
  ...(await importOriginal()),
  listProposals: async () => queues.drafts,
  deleteProposalDraft: async () => {},
}));

const { EvaluatorQueue, ResearcherProposals } = await import("../../src/components/RoleViews.jsx");

const navigate = (route) => queues.navigated.push(route);
const SOON = "2026-09-20T00:00:00.000Z";
const LATER = "2026-10-20T00:00:00.000Z";

describe("QCDAO-62 tracking my own proposals", () => {
  afterEach(cleanup);
  beforeEach(() => {
    queues.navigated = [];
    queues.drafts = [];
    queues.mine = { items: [
      { id: "p1", title: "Quantum routing", status: "submitted", createdAt: "2026-09-01T00:00:00.000Z",
        problemId: "problem-1", posting: { id: "problem-1", title: "Cold-chain routing", status: "open", expiresAt: LATER },
        comments: 2, qualifying: 1, recommendations: ["recommend"] },
      { id: "p2", title: "Annealing study", status: "withdrawn", createdAt: "2026-09-05T00:00:00.000Z",
        problemId: "problem-2", posting: { id: "problem-2", title: "Scheduling", status: "open", expiresAt: SOON },
        comments: 0, qualifying: 0, recommendations: [] },
    ] };
  });

  it("shows feedback progress, comment count and a deep link into the proposal", async () => {
    render(<ResearcherProposals onNavigate={navigate} />);
    await screen.findByText("Quantum routing");
    expect(screen.getByText(/1 evaluator recommendation: Recommend/)).toBeTruthy();
    expect(screen.getByText(/2 comments/)).toBeTruthy();
    expect(screen.getByText(/Awaiting evaluator recommendation/)).toBeTruthy();
    // The opportunity is named, not linked: only the proposal is clickable.
    expect(screen.getByText(/Proposal for: Cold-chain routing/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cold-chain routing" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "View proposal" })[0]);
    expect(queues.navigated).toEqual(["proposal/p2"]);
  });

  it("shows the parent posting's pending match instead of Open", async () => {
    const deadlineAt = new Date(Date.now() + 2 * 864e5).toISOString();
    queues.mine.items[0].posting = { ...queues.mine.items[0].posting, expiresAt: new Date(Date.now() + 80 * 864e5).toISOString(),
      matching: { status: "awaiting_confirmation", deadlineAt, confirmedAt: null } };
    const { container } = render(<ResearcherProposals onNavigate={navigate} />);
    await screen.findByText("Quantum routing");
    const row = screen.getByText("Quantum routing").closest(".table-row");
    expect(row.querySelector(".expiry-urgency").textContent).toBe("Awaiting creator acceptance");
    expect(container.textContent).toContain("Awaiting creator acceptance");
  });

  it("orders by closing soonest and filters by workflow status", async () => {
    const { container } = render(<ResearcherProposals onNavigate={navigate} />);
    await screen.findByText("Quantum routing");
    const titles = () => [...container.querySelectorAll(".table-row")].map((row) => row.querySelector("strong")?.textContent);
    expect(titles()).toEqual(["Annealing study", "Quantum routing"]);
    fireEvent.change(screen.getByLabelText(/Status/), { target: { value: "withdrawn" } });
    await waitFor(() => expect(titles()).toEqual(["Annealing study"]));
  });
});

describe("QCDAO-63 the evaluator recommendation queue", () => {
  afterEach(cleanup);
  const pending = { id: "s1", title: "Soon solution", status: "submitted", submittedAt: "2026-09-02T00:00:00.000Z",
    posting: { id: "problem-2", title: "Scheduling", status: "open", expiresAt: SOON }, recommendationStatus: "pending", recommendation: null };
  const done = { id: "s2", title: "Reviewed solution", status: "submitted", submittedAt: "2026-09-01T00:00:00.000Z",
    posting: { id: "problem-1", title: "Cold-chain routing", status: "open", expiresAt: LATER },
    recommendationStatus: "submitted", recommendation: "recommend_with_revisions" };

  beforeEach(() => {
    queues.navigated = [];
    queues.evaluator = async ({ filter }) => ({ filter, nextCursor: null,
      items: filter === "submitted" ? [done] : filter === "all" ? [pending, done] : [pending] });
  });

  it("lists what still needs my recommendation and opens it for review", async () => {
    render(<EvaluatorQueue onNavigate={navigate} />);
    await screen.findByText("Soon solution");
    expect(screen.getByText(/Scheduling/)).toBeTruthy();
    expect(screen.getByText(/No recommendation yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open proposal" }));
    expect(queues.navigated).toContain("proposal/s1");
  });

  it("separates the solutions I have already recommended on", async () => {
    render(<EvaluatorQueue onNavigate={navigate} />);
    await screen.findByText("Soon solution");
    fireEvent.click(screen.getByRole("tab", { name: "My recommendations" }));
    await screen.findByText(/My recommendation: Recommend with revisions/);
    expect(screen.queryByText("Soon solution")).toBeNull();
  });

  it("offers only the two states a solution can be in, with no wider pool", async () => {
    render(<EvaluatorQueue onNavigate={navigate} />);
    await screen.findByText("Soon solution");
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["Awaiting recommendation", "My recommendations"]);
  });

  it("explains a refusal when the account is not an assigned evaluator", async () => {
    queues.evaluator = async () => {
      const error = new Error("Only an assigned evaluator can open this queue.");
      error.code = "functions/permission-denied";
      throw error;
    };
    render(<EvaluatorQueue onNavigate={navigate} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/assigned evaluator/)).toBeTruthy();
  });

  it("shows a pending match instead of Open and withdraws Edit while the posting is locked", async () => {
    const deadlineAt = new Date(Date.now() + 2 * 864e5).toISOString();
    mocks.postings = [
      { ...PUBLISHED, id: "locked1", title: "Awaiting acceptance", expiresAt: new Date(Date.now() + 80 * 864e5),
        matching: { status: "awaiting_confirmation", deadlineAt, proposalId: "p1" } },
      { ...PUBLISHED, id: "open1", title: "Still open", expiresAt: new Date(Date.now() + 80 * 864e5) },
    ];
    render(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Awaiting acceptance")).toBeTruthy());

    const locked = screen.getByText("Awaiting acceptance").closest(".table-row");
    expect(locked.querySelector(".status-dot").textContent).toBe("Awaiting creator acceptance");
    expect(locked.querySelector(".status-dot").className).toContain("is-awaiting");
    expect(locked.textContent).not.toContain("Edit");

    const open = screen.getByText("Still open").closest(".table-row");
    expect(open.querySelector(".status-dot").textContent).not.toBe("Awaiting creator acceptance");
    expect(open.textContent).toContain("Edit");
  });
});
