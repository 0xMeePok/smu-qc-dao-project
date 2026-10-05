import React from "react";
import { cleanup, fireEvent, render as renderBare, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** QCDAO-50 - drafts on the owner's workspace. */

// Both workspaces read their action items through react-query, so every render
// here needs a client. Shadowing `render` keeps that one decision in one place.
const render = (ui) => renderBare(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>,
);

// QCDAO-92/93 put the roll-up on the leading tab. These suites assert the
// management tables, so they open that tab first.
function openWorkspaceTab(name) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

const renderOwner = (ui) => { const result = render(ui); openWorkspaceTab("My postings"); return result; };
const renderDeveloper = (ui) => { const result = render(ui); openWorkspaceTab("My submissions"); return result; };

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
    renderOwner(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Half-written idea")).toBeTruthy());
    expect(screen.getByText("Cold-chain routing")).toBeTruthy();
  });

  it("[FIT-P50-12] marks every draft with a badge, and nothing else", async () => {
    renderOwner(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getAllByText("Draft")).toHaveLength(2));
  });

  it("[FIT-P50-13] labels an untitled draft rather than showing a blank row", async () => {
    renderOwner(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Untitled draft")).toBeTruthy());
  });

  it("[FIT-P50-14] shows when each draft was last saved", async () => {
    renderOwner(<MyProblems onNavigate={() => {}} />);
    // "Last saved " and the instant are separate text nodes, so match the row.
    await waitFor(() => expect(
      screen.getByText((_, el) => el?.textContent === "Last saved 2026-09-01 10:15:00 UTC"),
    ).toBeTruthy());
  });

  it("[FIT-P50-15] resumes a draft on the create form, not the detail page", async () => {
    const onNavigate = vi.fn();
    renderOwner(<MyProblems onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByText("Half-written idea")).toBeTruthy());

    fireEvent.click(screen.getAllByText("Resume editing")[0]);
    expect(onNavigate).toHaveBeenCalledWith("create/draft1");
  });

  it("[FIT-P50-16] opens a published posting on the detail page", async () => {
    const onNavigate = vi.fn();
    renderOwner(<MyProblems onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByText("Cold-chain routing")).toBeTruthy());

    fireEvent.click(screen.getByText("View"));
    expect(onNavigate).toHaveBeenCalledWith("posting/live1");
  });

  it("opens a published posting on the edit form", async () => {
    const onNavigate = vi.fn();
    renderOwner(<MyProblems onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByText("Cold-chain routing")).toBeTruthy());
    fireEvent.click(screen.getByText("Edit"));
    expect(onNavigate).toHaveBeenCalledWith("edit-posting/live1");
  });

  it("closes a confirmed main winner's posting timer while keeping grant and pending-request timers open", async () => {
    const expiry = "2099-10-09T00:00:00.000Z";
    mocks.postings = [
      { ...PUBLISHED, id: "confirmed", title: "Confirmed main winner", expiresAt: expiry, hasAcceptedSolution: true, acceptedProposalId: "winner" },
      { ...PUBLISHED, id: "grant", title: "Grant with an award", expiresAt: expiry, opportunityType: "open-funding", hasAcceptedSolution: true, acceptedProposalId: "grant-winner" },
      { ...PUBLISHED, id: "requested", title: "Pending main request", expiresAt: expiry, escrowSelection: { proposalId: "candidate" } },
    ];
    renderOwner(<MyProblems onNavigate={() => {}} />);
    const confirmed = (await screen.findByText("Confirmed main winner")).closest(".table-row");
    expect(within(confirmed).getByText("Decision recorded")).toBeTruthy();
    expect(confirmed.querySelector(".expiry-countdown")).toBeNull();
    expect(within(confirmed).queryByRole("button", { name: "Edit" })).toBeNull();
    for (const title of ["Grant with an award", "Pending main request"]) {
      const item = screen.getByText(title).closest(".table-row");
      expect(within(item).getByText("Submitted")).toBeTruthy();
      expect(item.querySelector(".expiry-countdown")).toBeTruthy();
    }
  });

  it("[FIT-P50-17] offers delete on drafts only", async () => {
    renderOwner(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Cold-chain routing")).toBeTruthy());
    // Two drafts, one published posting.
    expect(screen.getAllByText("Delete")).toHaveLength(2);
  });

  it("[FIT-P50-18] asks for confirmation before deleting", async () => {
    renderOwner(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Half-written idea")).toBeTruthy());

    fireEvent.click(screen.getAllByText("Delete")[0]);
    expect(screen.getByText("Delete this draft?")).toBeTruthy();
    // Nothing is removed until the dialog is confirmed.
    expect(mocks.deleted).toEqual([]);
  });

  it("[FIT-P50-19] keeps the draft when the dialog is dismissed", async () => {
    renderOwner(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Half-written idea")).toBeTruthy());

    fireEvent.click(screen.getAllByText("Delete")[0]);
    fireEvent.click(screen.getByText("Keep it"));

    await waitFor(() => expect(screen.queryByText("Delete this draft?")).toBeNull());
    expect(mocks.deleted).toEqual([]);
    expect(screen.getByText("Half-written idea")).toBeTruthy();
  });

  it("[FIT-P50-20] deletes only once confirmed, then refreshes the list", async () => {
    renderOwner(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Half-written idea")).toBeTruthy());

    fireEvent.click(screen.getAllByText("Delete")[0]);
    fireEvent.click(screen.getByText("Delete draft"));

    await waitFor(() => expect(mocks.deleted).toEqual(["draft1"]));
    await waitFor(() => expect(screen.queryByText("Half-written idea")).toBeNull());
  });

  it("[FIT-P50-21] tells the owner when there are no drafts yet", async () => {
    mocks.postings = [PUBLISHED];
    renderOwner(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no drafts/i)).toBeTruthy());
  });
});


it("QCDAO-132 can load and resume a draft older than the first 50 postings", async () => {
  mocks.postings = [...Array.from({ length: 50 }, (_, i) => ({ ...PUBLISHED, id: `p${i}`, title: `Published ${i}` })), DRAFT];
  const onNavigate = vi.fn();
  renderOwner(<MyProblems onNavigate={onNavigate} />);
  await screen.findByRole("button", { name: "Load older opportunities" });
  expect(screen.queryByText(DRAFT.title)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load older opportunities" }));
  await screen.findByText(DRAFT.title);
  fireEvent.click(screen.getByRole("button", { name: "Resume editing" }));
  expect(onNavigate).toHaveBeenCalledWith("create/draft1");
  expect(screen.queryByRole("button", { name: "Load older opportunities" })).toBeNull();
});

/** QCDAO-62/63 - the researcher's tracking list and the evaluator's queue. */
const queues = vi.hoisted(() => ({ mine: { items: [] }, drafts: [], evaluator: async () => ({ items: [], nextCursor: null }), navigated: [],
  actions: null, selected: [], confirmed: [],
  ownerDashboard: { postings: [], accepted: [], blockers: [], truncated: {}, generatedAt: "2026-10-03T00:00:00.000Z",
    totals: { postings: 0, drafts: 0, live: 0, closed: 0, proposalsReceived: 0, awaitingFeedback: 0, readyToSelect: 0,
      blockedPostings: 0, acceptedSolutions: 0 } } }));

vi.mock("../../src/lib/proposalQueues.js", async (importOriginal) => ({
  ...(await importOriginal()),
  listMyProposalQueue: async () => queues.mine,
  listEvaluatorQueue: async (payload) => queues.evaluator(payload),
  listActionItems: async () => queues.actions,
  listOwnerDashboard: async () => queues.ownerDashboard,
}));

vi.mock("../../src/lib/matching.js", async (importOriginal) => ({
  ...(await importOriginal()),
  selectMockProposal: async (payload) => { queues.selected.push(payload); },
  confirmMockProposal: async (payload) => { queues.confirmed.push(payload); },
}));

vi.mock("../../src/lib/proposals.js", async (importOriginal) => ({
  ...(await importOriginal()),
  listProposals: async () => queues.drafts,
  deleteProposalDraft: async () => {},
}));

const { ActionNeeded, EvaluatorQueue, ResearcherProposals } = await import("../../src/components/RoleViews.jsx");

const navigate = (route) => queues.navigated.push(route);
const SOON = "2026-09-20T00:00:00.000Z";
const LATER = "2026-10-20T00:00:00.000Z";

describe("QCDAO-62 tracking my own proposals", () => {
  afterEach(cleanup);
  beforeEach(() => {
    queues.navigated = [];
    queues.drafts = [];
    queues.mine = { items: [
      { id: "p1", title: "Quantum routing", status: "submitted", workflowStatus: "submitted", createdAt: "2026-09-01T00:00:00.000Z",
        problemId: "problem-1", posting: { id: "problem-1", title: "Cold-chain routing", status: "open", expiresAt: LATER },
        comments: 2, qualifying: 1, recommendations: ["recommend"] },
      { id: "p2", title: "Annealing study", status: "withdrawn", workflowStatus: "declined", createdAt: "2026-09-05T00:00:00.000Z",
        problemId: "problem-2", posting: { id: "problem-2", title: "Scheduling", status: "open", expiresAt: SOON },
        comments: 0, qualifying: 0, recommendations: [] },
    ] };
  });

  it("shows feedback progress, comment count and a deep link into the proposal", async () => {
    renderDeveloper(<ResearcherProposals onNavigate={navigate} />);
    await screen.findByText("Quantum routing");
    // QCDAO-91: lifecycle and evaluator feedback render as shared status badges.
    expect(screen.getByText("Evaluator · Recommend")).toBeTruthy();
    expect(screen.getByText(/2 comments/)).toBeTruthy();
    expect(screen.getByText("Awaiting evaluator feedback")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Declined" })).toBeTruthy();
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
    const { container } = renderDeveloper(<ResearcherProposals onNavigate={navigate} />);
    await screen.findByText("Quantum routing");
    const row = screen.getByText("Quantum routing").closest(".table-row");
    expect(row.querySelector(".expiry-urgency").textContent).toBe("Pending approval");
    expect(container.textContent).toContain("Pending approval");
  });

  it("orders by closing soonest and filters by workflow status", async () => {
    const { container } = renderDeveloper(<ResearcherProposals onNavigate={navigate} />);
    await screen.findByText("Quantum routing");
    const titles = () => [...container.querySelectorAll(".table-row")].map((row) => row.querySelector("strong")?.textContent);
    expect(titles()).toEqual(["Annealing study", "Quantum routing"]);
    fireEvent.change(screen.getByLabelText(/Status/), { target: { value: "declined" } });
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
    expect(screen.getByText("Awaiting evaluator feedback")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open proposal" }));
    expect(queues.navigated).toContain("proposal/s1");
  });

  it("separates the solutions I have already recommended on", async () => {
    render(<EvaluatorQueue onNavigate={navigate} />);
    await screen.findByText("Soon solution");
    fireEvent.click(screen.getByRole("tab", { name: "My recommendations" }));
    await screen.findByText("My recommendation · Recommend with revisions");
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
    renderOwner(<MyProblems onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Awaiting acceptance")).toBeTruthy());

    const locked = screen.getByText("Awaiting acceptance").closest(".table-row");
    expect(locked.querySelector(".workflow-badge").textContent).toBe("Pending approval");
    expect(locked.querySelector(".workflow-badge").className).toContain("tone-warning");
    expect(locked.textContent).not.toContain("Edit");

    const open = screen.getByText("Still open").closest(".table-row");
    expect(open.querySelector(".workflow-badge").textContent).toBe("Submitted");
    expect(open.textContent).toContain("Edit");
  });
});

describe("[QCDAO-91] the shared Action Needed tab", () => {
  afterEach(cleanup);
  const item = (id, extra = {}) => ({ id, title: `Proposal ${id}`, problemId: "problem-1",
    posting: { id: "problem-1", title: "Cold-chain routing" }, amount: 100, currency: "SGD", fundedAmount: 100,
    workflowStatus: "submitted", recommendations: { recommend: 1, recommend_with_revisions: 0, do_not_recommend: 0 },
    submittedAt: SOON, ...extra });
  const empty = { total: 0, owner: { readyToSelect: [], awaitingReview: [] }, researcher: { selectionToAccept: [] }, evaluator: null };
  const renderTab = () => render(<ActionNeeded onNavigate={navigate} />);
  beforeEach(() => { queues.navigated = []; queues.selected = []; queues.confirmed = []; });

  it("groups what waits on me by role and selects in place with the comparison's dialog", async () => {
    queues.actions = { total: 4, owner: { readyToSelect: [item("s1")], awaitingReview: [item("r1", { revisionPathOpen: true })] },
      researcher: { selectionToAccept: [item("a1", { workflowStatus: "selected", deadlineAt: LATER })] },
      evaluator: { awaitingRecommendation: [item("e1")], more: true } };
    renderTab();
    await screen.findByText("Ready to select");
    for (const heading of ["Awaiting my review", "Selection to accept", "Awaiting my recommendation"]) expect(screen.getByText(heading)).toBeTruthy();
    expect(screen.getAllByText("Evaluator · Recommend")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Open the evaluation queue" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select…" }));
    const dialog = screen.getByRole("dialog", { name: "Select this proposal?" });
    fireEvent.change(within(dialog).getByLabelText("Selection rationale"), { target: { value: "Meets every constraint posted." } });
    queues.actions = empty;
    fireEvent.click(within(dialog).getByRole("button", { name: "Select and accept" }));
    await screen.findByText(/Selection recorded/);
    expect(queues.selected).toEqual([{ problemId: "problem-1", proposalId: "s1", rationale: "Meets every constraint posted." }]);
    await screen.findByText("Nothing needs your attention right now.");
  });

  it("answers a selection with the matching panel's accept dialog", async () => {
    queues.actions = { ...empty, total: 1, researcher: { selectionToAccept: [item("a1", { workflowStatus: "selected", deadlineAt: LATER })] } };
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Accept…" }));
    const dialog = screen.getByRole("dialog", { name: "Accept this selection?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record my acceptance" }));
    await screen.findByText(/Your acceptance is recorded/);
    expect(queues.confirmed).toEqual([{ problemId: "problem-1", proposalId: "a1" }]);
  });

  it("opens escrow proposals for review where current on-chain edit eligibility can be checked", async () => {
    queues.actions = { ...empty, total: 1, owner: { readyToSelect: [], awaitingReview: [item("escrow1", { fundingTerms: {} })] } };
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Review proposal" }));
    expect(queues.navigated).toEqual(["proposal/escrow1"]);
    expect(screen.queryByRole("button", { name: "Record review…" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens verified grant acceptance at its funding tab without a mock acceptance dialog", async () => {
    queues.actions = { ...empty, total: 1, researcher: { selectionToAccept: [], grantSelectionsToAccept: [item("grant1", {
      fundingTerms: {}, grant: { status: "pending", canAccept: true, deadlineAt: "2099-10-09T00:00:00.000Z" },
      posting: { title: "Closed grant call", status: "expired", expiresAt: SOON },
    })] } };
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Accept grant" }));
    expect(queues.navigated).toEqual(["proposal/grant1?tab=funding"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept…" })).toBeNull();
    expect(queues.confirmed).toEqual([]);
  });

  it.each([["select", "Select proposal", "submitted", "Submitted"], ["approve_upfront", "Approve upfront payment", "pending_approval", "Pending approval"],
    ["submit_delivery", "Submit delivery evidence", "accepted", "Accepted"], ["approve_delivery", "Approve delivery", "accepted", "Accepted"]])("routes the verified %s escrow action directly to funding", async (action, label, workflowStatus, badge) => {
    queues.actions = { ...empty, total: 1, escrowActions: [item("escrow1", { action, escrowState: "Locked", workflowStatus, deadlineAt: LATER })] };
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: label }));
    expect(screen.getByText("Proposal escrow1").closest(".table-row").querySelector(".workflow-badge").textContent).toBe(badge);
    expect(screen.getByText("Proposal escrow1").closest(".table-row").textContent).toContain(action === "select" ? "Funding closes" : "Approval ends");
    expect(queues.navigated).toEqual(["proposal/escrow1?tab=funding"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(queues.selected).toEqual([]);
    expect(queues.confirmed).toEqual([]);
  });

  it("retains unavailable verification warnings in an empty action queue and supports refresh", async () => {
    queues.actions = { ...empty, unavailableGrantOffers: 1, unavailableEscrows: 2 };
    renderTab();
    expect(await screen.findByText(/1 grant offer records could not be verified/)).toBeTruthy();
    expect(screen.getByText(/2 escrow records could not be verified/)).toBeTruthy();
    expect(screen.getByText(/No verified actions are available yet/)).toBeTruthy();
    expect(screen.queryByText("Nothing needs your attention right now.")).toBeNull();
    queues.actions = empty;
    fireEvent.click(screen.getByRole("button", { name: "Refresh actions" }));
    await screen.findByText("Nothing needs your attention right now.");
    expect(screen.queryByText(/could not be verified/)).toBeNull();
  });
  it("labels a limited empty action queue as partial instead of claiming no attention is needed", async () => {
    queues.actions = { ...empty, truncated: true };
    renderTab();
    expect(await screen.findByText(/action count is partial/)).toBeTruthy();
    expect(screen.getByText(/No actions are shown in this limited result/)).toBeTruthy();
    expect(screen.queryByText("Nothing needs your attention right now.")).toBeNull();
  });
});
