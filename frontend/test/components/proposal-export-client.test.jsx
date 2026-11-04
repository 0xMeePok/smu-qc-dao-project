import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportToCsv } from "../../../firebase/functions/proposalExportFormat.js";
const mocks = vi.hoisted(() => ({ call: vi.fn(), require: vi.fn() }));
vi.mock("firebase/functions", () => ({ httpsCallable: () => mocks.call }));
vi.mock("../../src/lib/firebase.js", () => ({ functions: {} }));
vi.mock("../../src/lib/authFlow.js", () => ({ requireFirebase: mocks.require }));
import { exportSelectedProposals, MAX_EXPORT_PART_BYTES } from "../../src/lib/proposalExport.js";
const scope = { mode: "proposal", acceptance: "all", proposalId: "proposal-a", startDate: null, endDate: null };
function comment(n, body = `Comment ${n}`, date = "2024-01-01T00:00:00.000Z") {
  return { id: `comment-${String(n).padStart(6, "0")}`, body, createdAt: date, qualifying: false };
}
function pages(comments, { size = 50, posting = {}, proposal = {} } = {}) {
  const chunks = [];
  for (let i = 0; i < Math.max(1, comments.length); i += size) chunks.push(comments.slice(i, i + size));
  let total = 0;
  return chunks.map((chunk, page) => {
    total += chunk.length;
    const done = page === chunks.length - 1;
    return { protocolVersion: 1, exportId: "session-a", page, postingIndex: 0, done, nextCursor: done ? null : { exportId: "session-a", page: page + 1 }, auditId: done ? "audit-a" : null,
      totals: { postingCount: 1, proposalCount: 1, commentCount: total },
      document: { schemaVersion: 2, exportedAt: "2024-02-01T00:00:00.000Z", scope, notice: "External grading.", postingCount: 1, proposalCount: 1, commentCount: chunk.length, postings: [{ id: "posting-a", title: "Posting", createdAt: null, acceptedAt: null, ...posting, proposals: [{ id: "proposal-a", title: "Proposal", ...proposal, comments: chunk }] }] } };
  });
}
function serve(responses) { for (const response of responses) mocks.call.mockResolvedValueOnce({ data: response }); }
const input = { proposalId: "proposal-a", acceptance: "all" };
beforeEach(() => { mocks.call.mockReset(); mocks.require.mockReset(); });

describe("bounded proposal export client", () => {
  it("delivers all 1001 unique comments as the exact complete JSON and CSV", async () => {
    const comments = Array.from({ length: 1001 }, (_, n) => comment(n, `=literal, \"${n}\"\n\r`));
    serve(pages(comments));
    const onPart = vi.fn(), progress = vi.fn();
    const result = await exportSelectedProposals(input, { onPart, onProgress: progress });
    expect(result.commentCount).toBe(1001);
    expect(result.document.postings[0].proposals[0].comments).toEqual(comments);
    expect(result.document.notice).toBe("External grading.");
    expect(result.csv).toBe(exportToCsv(result.document));
    expect(result.csv.match(/'=literal/g)).toHaveLength(1001);
    expect(onPart).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith({ postingCount: 1, proposalCount: 1, commentCount: 1001 });
    expect(mocks.call.mock.calls[0][0]).toMatchObject({ ...input, protocolVersion: 1, requestId: expect.any(String) });
    expect(mocks.call.mock.calls[1][0]).toEqual({ exportId: "session-a", page: 1 });
  });
  it("sorts missing, epoch, equal, and different dates with the established ID tiebreak", async () => {
    const comments = [comment(0, "a", "2024-01-02T00:00:00.000Z"), comment(1, "b", null), comment(2, "c", "1970-01-01T00:00:00.000Z"), comment(3, "d", "1970-01-01T00:00:00.000Z")];
    serve(pages(comments, { size: 2 }));
    const result = await exportSelectedProposals(input);
    expect(result.document.postings[0].proposals[0].comments.map((c) => c.id)).toEqual([comments[1].id, comments[2].id, comments[3].id, comments[0].id]);
  });
  it.each([
    ["replayed page", (p) => { p[1].page = 0; }],
    ["cross session", (p) => { p[1].exportId = "other"; }],
    ["nonprogressing cursor", (p) => { p[0].nextCursor.page = 0; }],
    ["changed header", (p) => { p[1].document.exportedAt = "2025-01-01"; }],
    ["changed totals", (p) => { p[1].totals.proposalCount = 2; }],
    ["wrong cumulative count", (p) => { p[1].totals.commentCount = 999; }],
    ["duplicate comments", (p) => { p[1].document.postings[0].proposals[0].comments[0].id = p[0].document.postings[0].proposals[0].comments[0].id; }],
    ["changed metadata", (p) => { p[1].document.postings[0].proposals[0].title = "changed"; }],
    ["missing terminal audit", (p) => { p[1].auditId = null; }],
  ])("rejects %s without delivering buffered small files", async (_, corrupt) => {
    const p = pages([comment(0), comment(1)], { size: 1 }); corrupt(p); serve(p);
    const onPart = vi.fn();
    await expect(exportSelectedProposals(input, { onPart })).rejects.toThrow(/inconsistent/i);
    expect(onPart).not.toHaveBeenCalled();
  });
  it("retries only transient failures with the exact same initial and continuation request", async () => {
    const p = pages([comment(0), comment(1)], { size: 1 });
    mocks.call.mockRejectedValueOnce({ code: "functions/unavailable" }).mockResolvedValueOnce({ data: p[0] }).mockRejectedValueOnce({ code: "functions/deadline-exceeded" }).mockResolvedValueOnce({ data: p[1] });
    await exportSelectedProposals(input);
    expect(mocks.call.mock.calls[0][0]).toEqual(mocks.call.mock.calls[1][0]);
    expect(mocks.call.mock.calls[2][0]).toEqual(mocks.call.mock.calls[3][0]);
  });
  it("does not retry permission errors or deliver normal files after a mid-export failure", async () => {
    const p = pages([comment(0), comment(1)], { size: 1 }); serve([p[0]]);
    mocks.call.mockRejectedValueOnce({ code: "functions/permission-denied" });
    const onPart = vi.fn();
    await expect(exportSelectedProposals(input, { onPart })).rejects.toMatchObject({ code: "functions/permission-denied" });
    expect(mocks.call).toHaveBeenCalledTimes(2); expect(onPart).not.toHaveBeenCalled();
  });
  it("bounds escaped multibyte parts and creates an authoritative manifest only after completion", async () => {
    const comments = Array.from({ length: 21 }, (_, n) => comment(n, '漢字🙂\"\r\n'.repeat(100)));
    serve(pages(comments, { size: 5 }));
    let delivered = 0, parts = 0;
    const result = await exportSelectedProposals(input, { maxPartBytes: 15000, onPart: (part) => {
      parts++; delivered += part.document.commentCount;
      expect(part.partNumber).toBe(parts);
      expect(part.document.notice).toMatch(/incomplete without.*completion manifest/);
      expect(part.bytes).toBeLessThanOrEqual(15000);
      expect(new TextEncoder().encode(`${JSON.stringify(part.document, null, 2)}\n`).length + new TextEncoder().encode(part.csv).length).toBe(part.bytes);
      expect(part.csv).toBe(exportToCsv(part.document));
    } });
    expect(delivered).toBe(21); expect(parts).toBeGreaterThan(1);
    expect(result).not.toHaveProperty("document");
    expect(result.manifest).toMatchObject({ status: "complete", auditId: "audit-a", partCount: parts, postingCount: 1, proposalCount: 1, commentCount: 21 });
    expect(JSON.stringify(result.manifest).length).toBeLessThan(1000);
  });
  it("fails before flushing if no callback is provided and a part would overflow", async () => {
    serve(pages(Array.from({ length: 10 }, (_, n) => comment(n, "x".repeat(1000))), { size: 2 }));
    await expect(exportSelectedProposals(input, { maxPartBytes: 6000 })).rejects.toThrow(/multiple files/i);
  });
  it("leaves partial segments incomplete on a late failure", async () => {
    const p = pages(Array.from({ length: 10 }, (_, n) => comment(n, "x".repeat(1000))), { size: 2 });
    serve(p.slice(0, 3)); mocks.call.mockRejectedValueOnce(new Error("lost access"));
    const onPart = vi.fn();
    await expect(exportSelectedProposals(input, { maxPartBytes: 6000, onPart })).rejects.toThrow("lost access");
    expect(onPart).toHaveBeenCalled();
    expect(onPart.mock.calls.every(([part]) => !part.manifest)).toBe(true);
  });
  it("cancels an in-flight call without fetching or flushing another page", async () => {
    const controller = new AbortController(), onPart = vi.fn();
    mocks.call.mockImplementationOnce(() => new Promise(() => {}));
    const result = exportSelectedProposals(input, { signal: controller.signal, onPart });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.call).toHaveBeenCalledTimes(1); expect(onPart).not.toHaveBeenCalled();
  });
  it("supports complete legacy responses during rollout and rejects unversioned cursors", async () => {
    const document = pages([comment(0)])[0].document;
    const legacy = { document, csv: exportToCsv(document), commentCount: 1 };
    mocks.call.mockResolvedValueOnce({ data: legacy });
    expect(await exportSelectedProposals(input)).toEqual({ ...legacy, csv: exportToCsv(document) });
    mocks.call.mockResolvedValueOnce({ data: { ...legacy, nextCursor: { page: 1 } } });
    await expect(exportSelectedProposals(input)).rejects.toThrow(/inconsistent/i);
  });
  it("does not permit raising the production part budget", async () => {
    await expect(exportSelectedProposals(input, { maxPartBytes: MAX_EXPORT_PART_BYTES + 1 })).rejects.toThrow(/Invalid export part size/);
    expect(mocks.call).not.toHaveBeenCalled();
  });
});


it("continues across empty transport pages without inventing empty proposal rows", async () => {
  const p = pages([comment(0), comment(1)], { size: 1 });
  const empty = structuredClone(p[0]);
  empty.page = 1; empty.nextCursor.page = 2;
  empty.document.postings = []; empty.document.postingCount = 0; empty.document.proposalCount = 0; empty.document.commentCount = 0;
  p[1].page = 2;
  serve([p[0], empty, p[1]]);
  const result = await exportSelectedProposals(input);
  expect(result.document.commentCount).toBe(2);
  expect(result.csv.split("\r\n")).toHaveLength(4);
});
it("keeps distinct missing-parent groups with empty posting IDs", async () => {
  const p = pages([comment(0), comment(1)], { size: 1, posting: { id: "" } });
  p[1].postingIndex = 1;
  p[1].document.postings[0].proposals[0].id = "proposal-b";
  for (const page of p) page.totals = { ...page.totals, postingCount: 2, proposalCount: 2 };
  serve(p);
  const result = await exportSelectedProposals(input);
  expect(result.document.postings.map((posting) => posting.id)).toEqual(["", ""]);
  expect(result.postingCount).toBe(2);
});
it("handles no selected proposals with a complete empty document", async () => {
  const page = pages([])[0];
  page.document.postings = []; page.document.postingCount = 0; page.document.proposalCount = 0;
  page.totals.postingCount = 0; page.totals.proposalCount = 0; page.postingIndex = null;
  serve([page]);
  const result = await exportSelectedProposals(input);
  expect(result.document.postings).toEqual([]); expect(result.proposalCount).toBe(0);
});
it("measures 5000-character multibyte and escaped bodies in bytes without truncating text", async () => {
  const bodies = ['漢'.repeat(5000), '\"\\\r\n'.repeat(1250), '🙂'.repeat(2500)];
  const comments = bodies.map((body, n) => comment(n, body));
  serve(pages(comments, { size: 3 }));
  const delivered = [];
  const result = await exportSelectedProposals(input, { maxPartBytes: 40000, onPart: (part) => {
    expect(part.bytes).toBeLessThanOrEqual(40000);
    delivered.push(...part.document.postings.flatMap((p) => p.proposals.flatMap((v) => v.comments.map((c) => c.body))));
  } });
  expect(result.multipart).toBe(true);
  expect(delivered).toEqual(bodies);
});
it("validates Unicode document IDs using Firestore UTF8 byte ordering", async () => {
  const comments = [comment(0), comment(1)];
  comments[0].id = '\uE000'; comments[1].id = '😀'; // UTF16 reverses this pair.
  serve(pages(comments, { size: 1 }));
  expect((await exportSelectedProposals(input)).commentCount).toBe(2);
});
it("does not invent an empty-comment CSV row on an empty terminal transport page", async () => {
  const first = pages([comment(0)])[0];
  first.done = false; first.auditId = null; first.nextCursor = { exportId: first.exportId, page: 1 };
  const terminal = structuredClone(first);
  terminal.page = 1; terminal.done = true; terminal.auditId = 'audit-a'; terminal.nextCursor = null;
  terminal.document.postings = []; terminal.document.postingCount = 0; terminal.document.proposalCount = 0; terminal.document.commentCount = 0;
  serve([first, terminal]);
  const result = await exportSelectedProposals(input);
  expect(result.document.commentCount).toBe(1);
  expect(result.csv.split('\r\n')).toHaveLength(3);
});


it("regenerates unsafe legacy CSV while preserving the raw NUL-prefixed JSON body", async () => {
  const body = "\0=1+1";
  const document = pages([comment(0, body)])[0].document;
  const safeCsv = exportToCsv(document);
  const unsafeCsv = safeCsv.replace("'" + body, body);
  expect(unsafeCsv).not.toBe(safeCsv);
  mocks.call.mockResolvedValueOnce({ data: { document, csv: unsafeCsv, commentCount: 1 } });
  const result = await exportSelectedProposals(input);
  expect(result.csv).toBe(safeCsv);
  expect(result.csv).toContain("," + "'" + body + ",");
  expect(result.document.postings[0].proposals[0].comments[0].body).toBe(body);
  expect(JSON.stringify(result.document)).toContain("\\u0000=1+1");
});
it("protects NUL-prefixed formulas in complete paged CSV and preserves JSON verbatim", async () => {
  const body = "\0=1+1";
  serve(pages([comment(0, body)]));
  const result = await exportSelectedProposals(input);
  expect(result.csv).toContain("," + "'" + body + ",");
  expect(result.document.postings[0].proposals[0].comments[0].body).toBe(body);
});
it("protects NUL-prefixed formulas in every numbered CSV without changing JSON bodies", async () => {
  const body = "\0=1+1";
  const comments = Array.from({ length: 10 }, (_, n) => comment(n, body));
  serve(pages(comments, { size: 2 }));
  let delivered = 0;
  const result = await exportSelectedProposals(input, { maxPartBytes: 2400, onPart: ({ document, csv }) => {
    const bodies = document.postings.flatMap((posting) => posting.proposals.flatMap((proposal) => proposal.comments.map((entry) => entry.body)));
    delivered += bodies.length;
    expect(bodies.every((entry) => entry === body)).toBe(true);
    expect(csv).toBe(exportToCsv(document));
    expect(csv.split("," + "'" + body + ",").length - 1).toBe(bodies.length);
  } });
  expect(result.multipart).toBe(true);
  expect(delivered).toBe(10);
  expect(result.manifest.commentCount).toBe(10);
});
