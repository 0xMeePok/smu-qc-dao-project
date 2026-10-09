import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), handlers: [], stops: [] }));
vi.mock("../../src/lib/liveActivity.js", () => ({ subscribeToActivity: (...args) => mocks.subscribe(...args) }));
import { useLiveActivity } from "../../src/hooks/useLiveActivity.js";
function Page(props) { useLiveActivity({ proposalId: "p1", channel: "funding", ...props }); return null; }
const tick = async ms => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => {
  vi.useFakeTimers(); mocks.handlers = []; mocks.stops = []; mocks.subscribe.mockReset();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  mocks.subscribe.mockImplementation((scope, channel, callback) => { const stop = vi.fn(); mocks.handlers.push(callback); mocks.stops.push(stop); return stop; });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("coalesces bursts and queues only one refresh while a request is in flight", async () => {
  let finish;
  const refresh = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  render(<Page onRefresh={refresh} />);
  act(() => { mocks.handlers[0](); mocks.handlers[0](); mocks.handlers[0](); });
  await tick(250); expect(refresh).toHaveBeenCalledTimes(1);
  act(() => { mocks.handlers[0](); mocks.handlers[0](); });
  await tick(5000); expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); }); await tick(250);
  expect(refresh).toHaveBeenCalledTimes(2);
});
it("defers updates during wallet work and uses the latest callback after it finishes", async () => {
  const old = vi.fn(), latest = vi.fn();
  const view = render(<Page blocked onRefresh={old} />);
  act(() => { mocks.handlers[0](); }); await tick(5000); expect(old).not.toHaveBeenCalled();
  view.rerender(<Page onRefresh={latest} />); await tick(250);
  expect(latest).toHaveBeenCalledTimes(1); expect(old).not.toHaveBeenCalled();
});
it("pauses hidden/offline listeners and refreshes once when the page returns", async () => {
  const refresh = vi.fn(); render(<Page onRefresh={refresh} />);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.stops[0]).toHaveBeenCalledTimes(1); await tick(180000); expect(refresh).not.toHaveBeenCalled();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  act(() => document.dispatchEvent(new Event("visibilitychange"))); await tick(250);
  expect(mocks.subscribe).toHaveBeenCalledTimes(2); expect(refresh).toHaveBeenCalledTimes(1);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  act(() => window.dispatchEvent(new Event("offline"))); await tick(180000); expect(refresh).toHaveBeenCalledTimes(1);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  act(() => window.dispatchEvent(new Event("online"))); await tick(250); expect(refresh).toHaveBeenCalledTimes(2);
});
it("cancels scheduled events after navigation, sign out and unmount", async () => {
  const old = vi.fn(), latest = vi.fn(); const view = render(<Page identity="alice" onRefresh={old} />);
  act(() => mocks.handlers[0]());
  view.rerender(<Page proposalId="p2" identity="bob" onRefresh={latest} />); await tick(250);
  expect(old).not.toHaveBeenCalled(); expect(latest).not.toHaveBeenCalled(); expect(mocks.stops[0]).toHaveBeenCalled();
  act(() => mocks.handlers[1]()); view.unmount(); await tick(61000); expect(latest).not.toHaveBeenCalled();
});
it("falls back once a minute without needing a backend signal", async () => {
  const refresh = vi.fn(); render(<Page onRefresh={refresh} intervalMs={10} />);
  await tick(59999); expect(refresh).not.toHaveBeenCalled(); await tick(251); expect(refresh).toHaveBeenCalledTimes(1);
  await tick(60000); expect(refresh).toHaveBeenCalledTimes(2);
});
it("does no work when disabled and recovers after a failed refresh", async () => {
  const refresh = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  const view = render(<Page enabled={false} onRefresh={refresh} />); await tick(61000); expect(mocks.subscribe).not.toHaveBeenCalled();
  view.rerender(<Page onRefresh={refresh} />); act(() => mocks.handlers[0]()); await tick(250);
  act(() => mocks.handlers[0]()); await tick(2000); expect(refresh).toHaveBeenCalledTimes(2);
});

it("distinguishes push-only bursts from timer/focus refreshes without losing the latter", async () => {
  const refresh = vi.fn(); const view = render(<Page blocked onRefresh={refresh} />);
  act(() => { mocks.handlers[0](); mocks.handlers[0](); });
  view.rerender(<Page onRefresh={refresh} />); await tick(250);
  expect(refresh).toHaveBeenLastCalledWith({ activityOnly: true, activitySnapshots: [null, null] });
  view.rerender(<Page blocked onRefresh={refresh} />);
  act(() => { window.dispatchEvent(new Event("focus")); mocks.handlers[0](); });
  view.rerender(<Page onRefresh={refresh} />); await tick(2000);
  expect(refresh).toHaveBeenLastCalledWith(expect.objectContaining({ activityOnly: false }));
  await tick(60000);
  expect(refresh).toHaveBeenLastCalledWith(expect.objectContaining({ activityOnly: false }));
});

it("retains uncovered events and forces a full read when a burst exceeds the metadata bound", async () => {
  const refresh = vi.fn(); const view = render(<Page blocked onRefresh={refresh} />);
  act(() => { mocks.handlers[0]({ fundingSnapshot: { blockNumber: 100 } }); mocks.handlers[0](); });
  view.rerender(<Page onRefresh={refresh} />); await tick(250);
  expect(refresh).toHaveBeenLastCalledWith({ activityOnly: true, activitySnapshots: [{ blockNumber: 100 }, null] });
  view.rerender(<Page blocked onRefresh={refresh} />);
  act(() => { for (let i = 0; i < 20; i++) mocks.handlers[0]({ fundingSnapshot: { blockNumber: i } }); });
  view.rerender(<Page onRefresh={refresh} />); await tick(2000);
  expect(refresh.mock.calls.at(-1)[0].activityOnly).toBe(false);
  expect(refresh.mock.calls.at(-1)[0].activitySnapshots).toHaveLength(8);
});
