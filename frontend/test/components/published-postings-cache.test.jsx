import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: {}, list: vi.fn() }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => mocks.auth }));
vi.mock("../../src/lib/postings.js", () => ({ listPublishedPostings: (...args) => mocks.list(...args) }));
import { usePublishedPostings } from "../../src/lib/usePublishedPostings.js";

const posting = (id) => ({ id, title: id, amount: 2, currency: "USDT", expiresAt: "2027-01-01T00:00:00Z" });
const page = (ids, cursor = null, hasMore = false) => ({ items: ids.map(posting), cursor, hasMore });
let client;
const wrapper = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
beforeEach(() => {
  mocks.auth = { user: { id: "0xABC" }, isAuthenticated: true };
  mocks.list.mockReset().mockResolvedValue(page(["first"]));
  client = new QueryClient();
});
afterEach(() => { cleanup(); client.clear(); });

it("reuses a recent Home result on Discover without another read", async () => {
  const home = renderHook(usePublishedPostings, { wrapper });
  await waitFor(() => expect(home.result.current.postings[0]?.id).toBe("first"));
  home.unmount();
  const discover = renderHook(usePublishedPostings, { wrapper });
  expect(discover.result.current.postings[0]?.id).toBe("first");
  expect(discover.result.current.loading).toBe(false);
  expect(mocks.list).toHaveBeenCalledTimes(1);
});

it("shares an in-flight initial request between consumers", async () => {
  mocks.list.mockImplementation(() => new Promise(() => {}));
  renderHook(usePublishedPostings, { wrapper });
  renderHook(usePublishedPostings, { wrapper });
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
});

it("keeps stale rows visible while a remount fetches current results", async () => {
  const first = renderHook(usePublishedPostings, { wrapper });
  await waitFor(() => expect(first.result.current.postings).toHaveLength(1));
  first.unmount();
  client.setQueryData(["publishedPostings", "0xabc"], old => old, { updatedAt: Date.now() - 31_000 });
  let finish;
  mocks.list.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const next = renderHook(usePublishedPostings, { wrapper });
  expect(next.result.current.postings[0].id).toBe("first");
  expect(next.result.current.loading).toBe(false);
  expect(next.result.current.fetching).toBe(true);
  await act(async () => finish(page(["updated"])));
  await waitFor(() => expect(next.result.current.postings[0].id).toBe("updated"));
});

it("preserves cursors and deduplicates pages across navigation", async () => {
  const cursor = { id: "first-cursor" };
  mocks.list.mockResolvedValueOnce(page(["first"], cursor, true)).mockResolvedValueOnce(page(["first", "second"]));
  const first = renderHook(usePublishedPostings, { wrapper });
  await waitFor(() => expect(first.result.current.hasMore).toBe(true));
  await act(async () => { await first.result.current.loadMore(); });
  await waitFor(() => expect(first.result.current.postings.map(item => item.id)).toEqual(["first", "second"]));
  expect(mocks.list).toHaveBeenNthCalledWith(2, { cursor });
  expect(first.result.current.hasMore).toBe(false);
  first.unmount();
  const next = renderHook(usePublishedPostings, { wrapper });
  expect(next.result.current.postings.map(item => item.id)).toEqual(["first", "second"]);
  expect(mocks.list).toHaveBeenCalledTimes(2);
});

it("keeps cached rows with an error and allows an explicit refresh immediately", async () => {
  const hook = renderHook(usePublishedPostings, { wrapper });
  await waitFor(() => expect(hook.result.current.postings).toHaveLength(1));
  mocks.list.mockRejectedValueOnce(new Error("Offline"));
  await act(async () => { await hook.result.current.refresh(); });
  await waitFor(() => expect(hook.result.current.loadError?.message).toBe("Offline"));
  expect(hook.result.current.postings[0].id).toBe("first");
  expect(hook.result.current.loading).toBe(false);
  mocks.list.mockResolvedValueOnce(page(["new"]));
  await act(async () => { await hook.result.current.refresh(); });
  await waitFor(() => expect(hook.result.current.postings[0].id).toBe("new"));
  expect(hook.result.current.loadError).toBeNull();
});

it("never exposes another wallet's cache or reads on sign-out", async () => {
  const hook = renderHook(usePublishedPostings, { wrapper });
  await waitFor(() => expect(hook.result.current.postings).toHaveLength(1));
  mocks.list.mockImplementation(() => new Promise(() => {}));
  mocks.auth = { user: { id: "0xDEF" }, isAuthenticated: true };
  hook.rerender();
  expect(hook.result.current.postings).toEqual([]);
  expect(hook.result.current.loading).toBe(true);
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  mocks.auth = { user: null, isAuthenticated: false };
  hook.rerender();
  expect(hook.result.current.postings).toEqual([]);
  expect(hook.result.current.loading).toBe(false);
  await act(async () => { await hook.result.current.refresh(); await hook.result.current.loadMore(); });
  expect(mocks.list).toHaveBeenCalledTimes(2);
});

it("does not request a second page while another request is running", async () => {
  mocks.list.mockResolvedValueOnce(page(["first"], "cursor", true));
  const hook = renderHook(usePublishedPostings, { wrapper });
  await waitFor(() => expect(hook.result.current.hasMore).toBe(true));
  mocks.list.mockImplementation(() => new Promise(() => {}));
  act(() => { hook.result.current.loadMore(); hook.result.current.loadMore(); });
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
});
