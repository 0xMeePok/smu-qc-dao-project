import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS } from "../../src/config/proposal.js";
const mocks = vi.hoisted(() => ({ user: { id: "member" }, report: vi.fn(), queue: vi.fn(), context: vi.fn(), moderate: vi.fn(), notifications: vi.fn(), markRead: vi.fn(), comments: vi.fn(), create: vi.fn(), edit: vi.fn(), remove: vi.fn() }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../src/lib/firebase.js", () => ({ functions: {} }));
vi.mock("../../src/lib/comments.js", async (importOriginal) => ({
  ...await importOriginal(),
  createComment: (...args) => mocks.create(...args),
  editComment: (...args) => mocks.edit(...args),
  deleteComment: (...args) => mocks.remove(...args),
}));
vi.mock("../../src/lib/moderation.js", async (importOriginal) => ({
  ...await importOriginal(),
  submitContentReport: (...args) => mocks.report(...args), listModerationQueue: (...args) => mocks.queue(...args),
  getModerationContext: (...args) => mocks.context(...args), moderateContent: (...args) => mocks.moderate(...args),
  listModerationNotifications: (...args) => mocks.notifications(...args), markModerationNotificationRead: (...args) => mocks.markRead(...args),
  listReportableComments: (...args) => mocks.comments(...args),
}));
import { ReportContentButton, ContentModerationNotice } from "../../src/components/ReportContentButton.jsx";
import { ModerationQueue } from "../../src/components/ModerationQueue.jsx";
import { ModerationNotifications } from "../../src/components/ModerationNotifications.jsx";
import { ReportableComments } from "../../src/components/ReportableComments.jsx";
const row = { id: "proposal_proposal1", contentType: "proposal", status: "pending", title: "Routing proposal", excerpt: "Short summary", authorId: "author1", authorName: "Researcher", organisation: "Research Lab", reportCount: 2, reasons: ["misleading"], createdAt: "2026-09-15T00:00:00Z" };
const notice = { id: "notice1", message: "Your proposal was hidden by a moderator.", contentType: "proposal", contentId: "proposal1", reason: "misleading", read: false, createdAt: "2026-09-15T00:00:00Z" };
const submitDialog = () => fireEvent.submit(screen.getByRole("dialog").querySelector("form"));
beforeEach(() => {
  mocks.user = { id: "member" };
  mocks.report.mockReset().mockResolvedValue({ ok: true });
  mocks.queue.mockReset().mockResolvedValue({ items: [row], pendingCount: 2 });
  mocks.context.mockReset().mockResolvedValue({ content: { title: "Routing proposal", methodology: "Full technical method" }, parent: { title: "Parent routing challenge", businessContext: "The complete parent context" }, reports: [{ id: "report1", reporterId: "reporter-private-id", reason: "misleading", details: "Explain disputed claim", createdAt: row.createdAt }], history: [] });
  mocks.moderate.mockReset().mockResolvedValue({ ok: true });
  mocks.notifications.mockReset().mockResolvedValue({ items: [notice] });
  mocks.markRead.mockReset().mockResolvedValue({ ok: true });
  mocks.comments.mockReset().mockResolvedValue({ items: [] });
  mocks.create.mockReset().mockResolvedValue({ id: "new-comment" });
  mocks.edit.mockReset().mockResolvedValue({ id: "comment1" });
  mocks.remove.mockReset().mockResolvedValue({ id: "comment1" });
});
afterEach(cleanup);

describe("private content reports", () => {
  it("requires a reason, records a report once, and exposes no reporter identity or public count", async () => {
    let finish;
    mocks.report.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<ReportContentButton contentType="proposal" contentId="proposal1" />);
    fireEvent.click(screen.getByRole("button", { name: "Report this proposal" }));
    expect(screen.getByText(/Your identity is visible only to administrators/)).toBeTruthy();
    submitDialog();
    expect(screen.getByRole("alert").textContent).toContain("Choose a reason");
    expect(mocks.report).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "misleading" } });
    fireEvent.change(screen.getByLabelText("Additional details (optional)"), { target: { value: "  Please inspect the accuracy claim.  " } });
    submitDialog(); submitDialog();
    expect(mocks.report).toHaveBeenCalledTimes(1);
    expect(mocks.report).toHaveBeenCalledWith({ contentType: "proposal", contentId: "proposal1", reason: "misleading", details: "Please inspect the accuracy claim." });
    await act(async () => { finish({ ok: true }); });
    expect(screen.getByRole("status").textContent).toContain("Report received");
    expect(screen.queryByRole("button", { name: "Report this proposal" })).toBeNull();
    expect(screen.queryByText("reporter-private-id")).toBeNull();
    expect(screen.queryByText(/\d+ reports/)).toBeNull();
  });

  it("offers retry after a report error and does not claim success", async () => {
    mocks.report.mockRejectedValueOnce(new Error("offline"));
    render(<ReportContentButton contentType="problem" contentId="problem1" />);
    fireEvent.click(screen.getByRole("button", { name: "Report this posting" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "duplicate" } });
    submitDialog();
    expect((await screen.findByRole("alert")).textContent).toContain("Please try again");
    expect(screen.queryByText(/Report received/)).toBeNull();
    submitDialog();
    await screen.findByText(/Report received/);
    expect(mocks.report).toHaveBeenCalledTimes(2);
  });

  it("hides reporting from signed-out visitors", () => {
    mocks.user = null;
    const { container } = render(<ReportContentButton contentType="proposal" contentId="proposal1" />);
    expect(container.textContent).toBe("");
  });

  it("explains hidden content status to its author without disclosing reporters", () => {
    render(<ContentModerationNotice record={{ moderationStatus: "hidden", moderation: { reason: "misleading", details: "Please clarify your supporting evidence." } }} />);
    expect(screen.getByText(/This content is hidden by moderation/)).toBeTruthy();
    expect(screen.getByText(/Misleading information/)).toBeTruthy();
    expect(screen.getByText(/author and administrators can still view it/)).toBeTruthy();
  });
});

describe("administrator moderation queue", () => {
  it("passes content/status/sort filters, paginates and updates pending count", async () => {
    const count = vi.fn();
    const cursor = { id: row.id, value: row.createdAt };
    mocks.queue.mockResolvedValue({ items: [row], pendingCount: 2, nextCursor: cursor });
    render(<ModerationQueue onCountChange={count} />);
    await screen.findByRole("heading", { name: "Routing proposal" });
    expect(count).toHaveBeenCalledWith(2);
    expect(screen.getByText(/2 reports/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Content type"), { target: { value: "proposal" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "hidden" } });
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "most_reported" } });
    await waitFor(() => expect(mocks.queue).toHaveBeenLastCalledWith({ contentType: "proposal", status: "hidden", sort: "most_reported" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await waitFor(() => expect(mocks.queue).toHaveBeenLastCalledWith({ contentType: "proposal", status: "hidden", sort: "most_reported", cursor }));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "all" } });
    await waitFor(() => expect(mocks.queue).toHaveBeenLastCalledWith({ contentType: "proposal", status: "all", sort: "most_reported" }));
  });

  it("loads full submission fields, parent context and private reports before a decision", async () => {
    const full = Object.fromEntries([...PROPOSAL_FIELDS, ...PROBLEM_FRAMING_FIELDS].map(([key]) => [key, `Full ${key} detail`]));
    mocks.context.mockResolvedValue({ content: full, parent: { title: "Parent challenge", summary: "Parent full summary" }, reports: [{ id: "report1", reporterId: "reporter-private-id", reason: "misleading", createdAt: row.createdAt }], history: [] });
    render(<ModerationQueue />);
    fireEvent.click(await screen.findByRole("button", { name: "Review content" }));
    await screen.findByText("Full methodology detail");
    for (const value of Object.values(full)) expect(screen.getByText(value)).toBeTruthy();
    expect(screen.getByText("Parent full summary")).toBeTruthy();
    expect(screen.getByText(/reporter-private-id/)).toBeTruthy();
    expect(mocks.context).toHaveBeenCalledWith(row.id);
  });

  it.each(["hide", "remove", "restore"])("requires a reason for %s and records the exact confirmed decision", async (action) => {
    render(<ModerationQueue />);
    fireEvent.click(await screen.findByRole("button", { name: "Review content" }));
    await screen.findByLabelText("Action");
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: action } });
    submitDialog();
    expect(screen.getByRole("alert").textContent).toContain("Choose an action and its reason");
    expect(mocks.moderate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: action === "restore" ? "no_violation" : "misleading" } });
    fireEvent.change(screen.getByLabelText("Additional explanation (optional)"), { target: { value: "  Reviewed against the complete source.  " } });
    submitDialog();
    await waitFor(() => expect(mocks.moderate).toHaveBeenCalledTimes(1));
    expect(mocks.moderate).toHaveBeenCalledWith({ queueId: row.id, action, reason: action === "restore" ? "no_violation" : "misleading", details: "Reviewed against the complete source." });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.queue).toHaveBeenCalledTimes(2);
  });

  it("keeps decisions disabled when full context fails to load", async () => {
    mocks.context.mockRejectedValueOnce(new Error("offline"));
    render(<ModerationQueue />);
    fireEvent.click(await screen.findByRole("button", { name: "Review content" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Record moderation decision" }).disabled).toBe(true);
    expect(mocks.moderate).not.toHaveBeenCalled();
  });
});

describe("author notices and reportable comments", () => {
  it("marks a private notice read only after server acknowledgement", async () => {
    let finish;
    mocks.markRead.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<ModerationNotifications userId="author1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark read" }));
    expect(screen.getByRole("button", { name: "Mark read" }).disabled).toBe(true);
    expect(mocks.markRead).toHaveBeenCalledWith("notice1");
    await act(async () => { finish({ ok: true }); });
    expect(screen.queryByRole("button", { name: "Mark read" })).toBeNull();
    expect(screen.getByText(notice.message)).toBeTruthy();
  });

  it("clears the previous account's private notices immediately when the account changes", async () => {
    const { rerender } = render(<ModerationNotifications userId="author1" />);
    await screen.findByText(notice.message);
    mocks.notifications.mockImplementationOnce(() => new Promise(() => {}));
    rerender(<ModerationNotifications userId="author2" />);
    expect(screen.queryByText(notice.message)).toBeNull();
    rerender(<ModerationNotifications userId={null} />);
    expect(screen.queryByText(notice.message)).toBeNull();
  });

  it("renders scoped comments with per-comment report actions", async () => {
    mocks.comments.mockResolvedValue({ items: [{ id: "comment1", body: "Review this technical claim.", authorName: "Researcher", createdAt: row.createdAt }] });
    render(<ReportableComments problemId="problem1" proposalId="proposal1" />);
    await screen.findByText("Review this technical claim.");
    expect(mocks.comments).toHaveBeenCalledWith({ problemId: "problem1", proposalId: "proposal1" });
    fireEvent.click(screen.getByRole("button", { name: "Report this comment" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "abusive" } });
    submitDialog();
    await screen.findByText(/Report received/);
    expect(mocks.report).toHaveBeenCalledWith({ contentType: "comment", contentId: "comment1", reason: "abusive", details: "" });
    expect(screen.queryByText(/\d+ reports/)).toBeNull();
  });

  it("keeps replies collapsed until expanded and posts a reply without a recommendation", async () => {
    mocks.user = { id: "evaluator", roles: ["evaluator"] };
    mocks.comments.mockResolvedValue({ items: [{
      id: "comment1", body: "The claimed latency needs a cited benchmark.", authorName: "Researcher",
      createdAt: row.createdAt, proposalId: "proposal1", parentId: null, replyCount: 1,
      replies: [{ id: "reply1", body: "Agree on the benchmark.", authorName: "Alice", parentId: "comment1",
        createdAt: row.createdAt, proposalId: "proposal1" }],
    }] });
    render(<ReportableComments problemId="problem1" proposalId="proposal1" />);
    await screen.findByText("The claimed latency needs a cited benchmark.");
    expect(screen.queryByText("Agree on the benchmark.")).toBeNull();
    expect(screen.queryByLabelText("Write a reply")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 reply" }));
    expect(screen.getByText("Agree on the benchmark.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reply", hidden: false })).toBeTruthy();
    expect(within(screen.getByText("Agree on the benchmark.").closest("article")).queryByRole("button", { name: "Reply" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Write a reply"), { target: { value: "Need the cited figure as well." } });
    fireEvent.click(screen.getByRole("button", { name: "Post reply" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({
      proposalId: "proposal1", body: "Need the cited figure as well.", parentId: "comment1",
    }));
    expect(mocks.create.mock.calls[0][0].recommendation).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Hide replies" }));
    expect(screen.queryByText("Agree on the benchmark.")).toBeNull();
  });

  it("lets a member post on a proposal and requires a recommendation from assigned evaluators", async () => {
    render(<ReportableComments problemId="problem1" proposalId="proposal1" />);
    fireEvent.change(await screen.findByLabelText("Write a comment"), { target: { value: "The claimed latency needs a cited benchmark." } });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ proposalId: "proposal1", body: "The claimed latency needs a cited benchmark." }));
  });

  it("requires assigned evaluators to pick a recommendation before posting", async () => {
    mocks.user = { id: "evaluator", roles: ["evaluator"] };
    render(<ReportableComments problemId="problem1" proposalId="proposal1" />);
    fireEvent.change(await screen.findByLabelText("Write a comment"), { target: { value: "The approach is sound with one revision." } });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Choose Recommend");
    expect(mocks.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Recommend with revisions"));
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({
      proposalId: "proposal1", body: "The approach is sound with one revision.", recommendation: "recommend_with_revisions",
    }));
  });

  it("requests newest comments when the sort control is changed", async () => {
    mocks.comments.mockResolvedValue({ items: [{ id: "comment1", body: "Review this technical claim.", authorName: "Researcher", createdAt: row.createdAt }] });
    render(<ReportableComments problemId="problem1" proposalId="proposal1" />);
    await screen.findByText("Review this technical claim.");
    fireEvent.change(screen.getByLabelText("Sort comments"), { target: { value: "newest" } });
    await waitFor(() => expect(mocks.comments).toHaveBeenLastCalledWith({ problemId: "problem1", proposalId: "proposal1", sort: "newest" }));
  });

  it("lets the author edit inside the window and delete, and shows evaluator outcome badges", async () => {
    mocks.user = { id: "evaluator", roles: ["evaluator"] };
    mocks.comments.mockResolvedValue({ items: [{
      id: "comment1", body: "Initial review.", authorId: "evaluator", authorName: "Assigned evaluator",
      authorRole: "evaluator", badge: "evaluator", recommendation: "recommend", qualifying: true,
      createdAt: new Date().toISOString(), proposalId: "proposal1",
    }] });
    render(<ReportableComments problemId="problem1" proposalId="proposal1" />);
    expect(await screen.findByText("Recommend")).toBeTruthy();
    expect(screen.getAllByText("Evaluator").length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    fireEvent.change(screen.getByLabelText("Edit comment"), { target: { value: "Updated review." } });
    fireEvent.click(screen.getByLabelText("Recommend"));
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(mocks.edit).toHaveBeenCalledWith({ commentId: "comment1", body: "Updated review.", recommendation: "recommend" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete comment" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("comment1"));
  });
});

it("does not offer a composer on posting-level discussion", async () => {
  mocks.comments.mockResolvedValue({ items: [{ id: "comment1", body: "A later public comment", createdAt: row.createdAt }] });
  render(<ReportableComments problemId="problem1" />);
  await screen.findByText("A later public comment");
  expect(screen.queryByLabelText("Write a comment")).toBeNull();
  expect(screen.queryByRole("button", { name: "Post comment" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
});

it("reaches public comments after a filtered empty page and retries pagination", async () => {
  const cursor = { id: "private100", value: row.createdAt, seconds: 1789430400, nanoseconds: 123 };
  mocks.comments.mockResolvedValueOnce({ items: [], nextCursor: cursor })
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ items: [{ id: "public101", body: "A later public comment", createdAt: row.createdAt }], nextCursor: null });
  render(<ReportableComments problemId="problem1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Load more comments" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry comments" }));
  await screen.findByText("A later public comment");
  expect(mocks.comments).toHaveBeenLastCalledWith({ problemId: "problem1", cursor });
  expect(screen.queryByRole("button", { name: "Load more comments" })).toBeNull();
});

it("discards an old comments page after the scope or account changes", async () => {
  let resolveOld;
  mocks.comments.mockResolvedValueOnce({ items: [{ id: "old", body: "Old account comment", createdAt: row.createdAt }], nextCursor: { id: "old", value: row.createdAt } })
    .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValueOnce({ items: [{ id: "new", body: "New account comment", createdAt: row.createdAt }] });
  const { rerender } = render(<ReportableComments problemId="problem1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Load more comments" }));
  mocks.user = { id: "different-member" };
  rerender(<ReportableComments problemId="problem2" />);
  expect(screen.queryByText("Old account comment")).toBeNull();
  await screen.findByText("New account comment");
  await act(async () => resolveOld({ items: [{ id: "stale", body: "Stale private comment", createdAt: row.createdAt }] }));
  expect(screen.queryByText("Stale private comment")).toBeNull();
});
