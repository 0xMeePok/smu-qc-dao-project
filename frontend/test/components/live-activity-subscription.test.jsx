import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ onSnapshot: vi.fn(), doc: vi.fn((...args) => args), db: {} }));
vi.mock("firebase/firestore", () => ({ doc: (...args) => mocks.doc(...args), onSnapshot: (...args) => mocks.onSnapshot(...args) }));
vi.mock("../../src/lib/firebase.js", () => ({ db: mocks.db }));
import { subscribeToActivity } from "../../src/lib/liveActivity.js";
it("shares a metadata listener by scope/session and dispatches only the changed channel", () => {
  let receive; const stop = vi.fn(); mocks.onSnapshot.mockImplementation((ref, callback) => { receive = callback; return stop; });
  const comments = vi.fn(), funding = vi.fn();
  const a = subscribeToActivity({ proposalId: "p", identity: "alice" }, "comments", comments);
  const b = subscribeToActivity({ proposalId: "p", identity: "alice" }, "funding", funding);
  expect(mocks.onSnapshot).toHaveBeenCalledTimes(1);
  expect(mocks.doc).toHaveBeenCalledWith(mocks.db, "proposals", "p", "activity", "latest");
  receive({ exists: () => false }); expect(comments).not.toHaveBeenCalled();
  receive({ exists: () => true, data: () => ({ comments: 1, funding: 0 }) }); expect(comments).toHaveBeenCalledTimes(1); expect(funding).not.toHaveBeenCalled();
  receive({ exists: () => true, data: () => ({ comments: 1, funding: 0 }) }); expect(comments).toHaveBeenCalledTimes(1);
  receive({ exists: () => true, data: () => ({ comments: 1, funding: 1 }) }); expect(funding).toHaveBeenCalledTimes(1);
  a(); expect(stop).not.toHaveBeenCalled(); b(); expect(stop).toHaveBeenCalledTimes(1);
});

it("supports combined channels and safely falls back when listener setup fails", () => {
  let receive; const stop = vi.fn(); mocks.onSnapshot.mockImplementation((ref, callback) => { receive = callback; return stop; });
  const refresh = vi.fn(), unsubscribe = subscribeToActivity({ problemId: "grant" }, "all", refresh);
  receive({ exists: () => true, data: () => ({ comments: 2, funding: 1 }) });
  receive({ exists: () => true, data: () => ({ comments: 2, funding: 2 }) });
  receive({ exists: () => true, data: () => ({ comments: 3, funding: 2 }) });
  expect(refresh).toHaveBeenCalledTimes(2); unsubscribe();
  mocks.onSnapshot.mockImplementation(() => { throw new Error("SDK unavailable"); });
  expect(() => subscribeToActivity({ problemId: "offline" }, "all", refresh)()).not.toThrow();
});
