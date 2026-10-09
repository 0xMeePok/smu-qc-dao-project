import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: { id: "reader" }, list: vi.fn(), live: null, create: vi.fn() }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../src/hooks/useLiveActivity.js", () => ({ useLiveActivity: (options) => { mocks.live = options; } }));
vi.mock("../../src/lib/moderation.js", () => ({ listReportableComments: (...args) => mocks.list(...args), moderationError: () => "Please retry" }));
vi.mock("../../src/lib/comments.js", () => ({ COMMENT_BODY_MAX: 5000, canEditComment: () => true, commentError: () => "Failed", createComment: (...args) => mocks.create(...args), deleteComment: vi.fn(), editComment: vi.fn(), RECOMMENDATIONS: [] }));
vi.mock("../../src/components/ReportContentButton.jsx", () => ({ ReportContentButton: () => null }));
import { ReportableComments } from "../../src/components/ReportableComments.jsx";
const item = (id, body, patch = {}) => ({ id, body, authorId: "other", authorName: "Other user", proposalId: "p", createdAt: "2026-10-09T00:00:00Z", ...patch });
const refresh = () => act(async () => { await mocks.live.onRefresh(); });
beforeEach(() => { mocks.user = { id: "reader" }; mocks.list.mockReset(); mocks.create.mockReset().mockResolvedValue({}); });
afterEach(cleanup);

it("updates another user's edits, deletions and new comments without clearing the typed comment", async () => {
  mocks.list.mockResolvedValueOnce({ items: [item("a", "Original"), item("b", "Remove me")] })
    .mockResolvedValueOnce({ items: [item("a", "Revised"), item("b", "", { deleted: true }), item("c", "New comment")] });
  render(<ReportableComments proposalId="p" />);
  await screen.findByText("Original");
  fireEvent.change(screen.getByLabelText("Write a comment"), { target: { value: "My unfinished thought" } });
  await refresh();
  expect(screen.getByText("Revised")).toBeTruthy();
  expect(screen.getByText("New comment")).toBeTruthy();
  expect(screen.getByText("This comment was removed")).toBeTruthy();
  expect(screen.queryByText("Remove me")).toBeNull();
  expect(screen.getByLabelText("Write a comment").value).toBe("My unfinished thought");
  expect(mocks.live).toMatchObject({ proposalId: "p", identity: "reader", channel: "comments", blocked: false });
});

it("refreshes all opened comment and reply pages while retaining expansion and a reply draft", async () => {
  const parent = item("a", "Thread", { replyCount: 3, replies: [item("r1", "First reply", { parentId: "a" })], nextReplyCursor: { id: "r1" } });
  let updated = false;
  mocks.list.mockImplementation(async ({ threadId, cursor }) => {
    if (threadId) return { items: [item("r2", updated ? "Updated second reply" : "Second reply", { parentId: "a" })], nextCursor: { id: "r2" } };
    if (cursor) return { items: [item("b", updated ? "Updated next page" : "Next page")] };
    return { items: [parent], nextCursor: { id: "a" } };
  });
  render(<ReportableComments proposalId="p" />);
  fireEvent.click(await screen.findByRole("button", { name: "Show 3 replies" }));
  fireEvent.click(screen.getByRole("button", { name: "Load more replies" }));
  await screen.findByText("Second reply");
  fireEvent.click(screen.getByRole("button", { name: "Load more comments" }));
  await screen.findByText("Next page");
  fireEvent.change(screen.getByLabelText("Write a reply"), { target: { value: "Unfinished reply" } });
  updated = true;
  await refresh();
  expect(screen.getByText("Updated second reply")).toBeTruthy();
  expect(screen.getByText("Updated next page")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Hide replies" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByLabelText("Write a reply").value).toBe("Unfinished reply");
  expect(screen.getByRole("button", { name: "Load more replies" })).toBeTruthy();
});

it("retains an edit draft when the server returns newer comment content", async () => {
  mocks.list.mockResolvedValueOnce({ items: [item("a", "Original", { authorId: "reader" })] })
    .mockResolvedValueOnce({ items: [item("a", "Remote edit", { authorId: "reader" })] });
  render(<ReportableComments proposalId="p" />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit comment" }));
  fireEvent.change(screen.getByLabelText("Edit comment"), { target: { value: "Unfinished edit" } });
  await refresh();
  expect(screen.getByLabelText("Edit comment").value).toBe("Unfinished edit");
});

it("ignores an in-flight quiet refresh after changing account or scope", async () => {
  let finish;
  mocks.list.mockResolvedValueOnce({ items: [item("a", "Old scope")] })
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce({ items: [item("b", "New scope")] });
  const view = render(<ReportableComments proposalId="p" />);
  await screen.findByText("Old scope");
  let pending;
  act(() => { pending = mocks.live.onRefresh(); });
  mocks.user = { id: "new-reader" };
  view.rerender(<ReportableComments proposalId="q" />);
  await screen.findByText("New scope");
  await act(async () => { finish({ items: [item("private", "Stale data")] }); await pending; });
  expect(screen.queryByText("Stale data")).toBeNull();
  expect(screen.getByText("New scope")).toBeTruthy();
});

it("blocks activity refresh during a pending post and refreshes after the post completes", async () => {
  let finish;
  mocks.list.mockResolvedValue({ items: [] });
  mocks.create.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<ReportableComments proposalId="p" />);
  await waitFor(() => expect(mocks.live.blocked).toBe(false));
  fireEvent.change(screen.getByLabelText("Write a comment"), { target: { value: "New post" } });
  fireEvent.click(screen.getByRole("button", { name: "Post comment" }));
  expect(mocks.live.blocked).toBe(true);
  mocks.list.mockResolvedValue({ items: [item("a", "New post")] });
  await act(async () => { finish({}); });
  await screen.findByText("New post");
  expect(mocks.live.blocked).toBe(false);
});

it("discards an older quiet response after a sort change", async () => {
  let finish;
  mocks.list.mockResolvedValueOnce({ items: [item("a", "Original sorted comment")] })
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce({ items: [item("b", "Newest first result")] });
  render(<ReportableComments proposalId="p" />);
  await screen.findByText("Original sorted comment");
  let pending;
  act(() => { pending = mocks.live.onRefresh(); });
  fireEvent.change(screen.getByLabelText("Sort comments"), { target: { value: "newest" } });
  await screen.findByText("Newest first result");
  await act(async () => { finish({ items: [item("stale", "Stale old sort")] }); await pending; });
  expect(screen.queryByText("Stale old sort")).toBeNull();
  expect(mocks.list).toHaveBeenLastCalledWith({ proposalId: "p", sort: "newest" });
});

it("keeps an edit draft recoverable when its comment is removed remotely", async () => {
  mocks.list.mockResolvedValueOnce({ items: [item("a", "Original", { authorId: "reader" })] })
    .mockResolvedValueOnce({ items: [item("a", "", { authorId: "reader", deleted: true })] });
  render(<ReportableComments proposalId="p" />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit comment" }));
  fireEvent.change(screen.getByLabelText("Edit comment"), { target: { value: "Recoverable draft" } });
  await refresh();
  expect(screen.getByLabelText("Edit comment").value).toBe("Recoverable draft");
  expect(screen.getByRole("button", { name: "Save comment" }).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("Your draft is still here");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByLabelText("Write a comment")).toBeTruthy();
});
