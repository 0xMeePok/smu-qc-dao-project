import { Suspense } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { lazyPage, PageLoadFailure, PageLoading } from "../../src/components/LazyPage.jsx";

afterEach(cleanup);

it("loads a page only when rendered and keeps a loading status while it downloads", async () => {
  let finish;
  const load = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const Page = lazyPage(load, "Workspace");
  expect(load).not.toHaveBeenCalled();
  render(<Suspense fallback={<PageLoading />}><Page /></Suspense>);
  expect(screen.getByRole("status").textContent).toContain("Loading page");
  finish({ Workspace: () => <h1>Workspace ready</h1> });
  expect(await screen.findByRole("heading", { name: "Workspace ready" })).toBeTruthy();
});

it("a removed deployment chunk offers recovery without automatically reloading the wallet session", async () => {
  sessionStorage.setItem("pending-transaction", "0x123");
  const Page = lazyPage(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
  render(<Suspense fallback={<PageLoading />}><Page /></Suspense>);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText(/finish it before reloading/)).toBeTruthy();
  expect(sessionStorage.getItem("pending-transaction")).toBe("0x123");
  expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
});

it("reload recovery requires an explicit click", () => {
  const reload = vi.fn();
  render(<PageLoadFailure reload={reload} />);
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
  expect(reload).toHaveBeenCalledTimes(1);
});
