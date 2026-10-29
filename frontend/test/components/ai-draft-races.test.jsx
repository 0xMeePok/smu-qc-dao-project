import { useState } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAIDrafting } from "../../src/hooks/useAIDrafting.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const reply = (suggestions = { summary: "AI summary" }) => ({ message: "Here are draft suggestions.", suggestions, suggestedTags: [], usage: { remainingToday: 19 } });
function setup(services, initial = {}) {
  return renderHook(({ recordId = "draft-a" } = {}) => {
    const [form, setForm] = useState({ title: "Cold chain route optimisation", summary: "", methodology: "", amount: "42.50", currency: "USDC", ...initial });
    const assistant = useAIDrafting({ kind: "independent", form, setForm, recordId, services });
    return { assistant, form, setForm };
  }, { initialProps: { recordId: "draft-a" } });
}

it("keeps text typed during generation and never includes payment fields in an AI request", async () => {
  const pending = deferred(), generate = vi.fn(() => pending.promise), similar = vi.fn(async () => ({ items: [], truncated: true }));
  const view = setup({ generate, similar });
  let request;
  act(() => { request = view.result.current.assistant.request(); });
  act(() => view.result.current.setForm(previous => ({ ...previous, summary: "Author's newer summary" })));
  await act(async () => { pending.resolve(reply()); await request; });
  expect(view.result.current.assistant.canAccept("summary")).toBe(false);
  act(() => view.result.current.assistant.accept(["summary"]));
  expect(view.result.current.form.summary).toBe("Author's newer summary");
  expect(view.result.current.form.amount).toBe("42.50");
  expect(view.result.current.form.currency).toBe("USDC");
  const sent = generate.mock.calls[0][0];
  expect(sent.fields.amount).toBeUndefined(); expect(sent.fields.currency).toBeUndefined();
});

it("does not replace an accepted AI field after the author edits it while regeneration runs", async () => {
  const pending = deferred(), generate = vi.fn().mockResolvedValueOnce(reply()).mockImplementationOnce(() => pending.promise);
  const view = setup({ generate, similar: vi.fn(async () => ({ items: [], truncated: true })) });
  await act(async () => { await view.result.current.assistant.request(); });
  act(() => view.result.current.assistant.accept(["summary"]));
  expect(view.result.current.form.summary).toBe("AI summary");
  let request;
  act(() => { request = view.result.current.assistant.request({ field: "summary" }); });
  act(() => view.result.current.setForm(previous => ({ ...previous, summary: "Author's corrected text" })));
  await act(async () => { pending.resolve(reply({ summary: "Regenerated text" })); await request; });
  expect(view.result.current.assistant.accepted.summary).toBeUndefined();
  act(() => view.result.current.assistant.accept(["summary"]));
  act(() => view.result.current.assistant.discard());
  expect(view.result.current.form.summary).toBe("Author's corrected text");
});

it("discards an in-flight generation after changing the draft record", async () => {
  const pending = deferred(), generate = vi.fn(() => pending.promise);
  const view = setup({ generate, similar: vi.fn(async () => ({ items: [], truncated: true })) });
  let request;
  act(() => { request = view.result.current.assistant.request(); });
  view.rerender({ recordId: "draft-b" });
  await act(async () => { pending.resolve(reply()); await request; });
  expect(view.result.current.assistant.messages).toEqual([]);
  expect(view.result.current.assistant.suggestions).toEqual({});
  expect(view.result.current.form.summary).toBe("");
});

it("ignores an old related-proposal response after the author changes the title", async () => {
  vi.useFakeTimers();
  const first = deferred(), second = deferred();
  const similar = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const view = setup({ generate: vi.fn(), similar });
  await act(async () => { vi.advanceTimersByTime(1100); });
  act(() => view.result.current.setForm(previous => ({ ...previous, title: "Sensor data encryption" })));
  await act(async () => { vi.advanceTimersByTime(1100); });
  await act(async () => { second.resolve({ items: [{ id: "new", title: "Encryption" }], truncated: true }); });
  await act(async () => { first.resolve({ items: [{ id: "old", title: "Routes" }], truncated: true }); });
  expect(view.result.current.assistant.similar.items.map(item => item.id)).toEqual(["new"]);
});
