import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getDoc: vi.fn(), getDocFromServer: vi.fn(), getDocs: vi.fn() }));
vi.mock("firebase/firestore", async original => ({
  ...await original(),
  doc: (_db, ...path) => ({ path: path.join("/") }),
  collection: (_db, ...path) => ({ path: path.join("/") }),
  where: (field, op, value) => ({ field, op, value }),
  query: (collection, ...constraints) => ({ ...collection, constraints }),
  getDoc: (...args) => mocks.getDoc(...args),
  getDocFromServer: (...args) => mocks.getDocFromServer(...args),
  getDocs: (...args) => mocks.getDocs(...args),
}));
vi.mock("../../src/lib/firebase.js", () => ({ db: {}, functions: {} }));
vi.mock("../../src/lib/authFlow.js", () => ({ requireFirebase: () => {} }));
vi.mock("../../src/lib/publication.js", () => ({ attestPublication: vi.fn(), reserveResource: vi.fn() }));
vi.mock("../../src/lib/attachments.js", () => ({ deleteAttachment: vi.fn(), toPostingRecord: value => value }));
vi.mock("../../src/lib/independentEscrow.js", () => ({ getIndependentFundingState: vi.fn(), independentFundingConfigured: () => false, independentFundingLocked: () => false }));
import { findPosting } from "../../src/lib/postings.js";
import { listProposals } from "../../src/lib/proposals.js";

const snapshot = (id, data) => ({ id, exists: () => Boolean(data), data: () => data });
beforeEach(() => vi.resetAllMocks());

it("starts metrics while the problem document is pending and preserves verified metric normalization", async () => {
  let finishPosting;
  mocks.getDoc.mockImplementation(({ path }) => path.startsWith("problems/")
    ? new Promise(resolve => { finishPosting = resolve; })
    : Promise.resolve(snapshot("p1", { version: 2, proposalCount: 4, fundedAmount: 20, fundingProgressPercent: 10 })));
  const request = findPosting("p1");
  expect(mocks.getDoc.mock.calls.map(([ref]) => ref.path)).toEqual(["opportunityMetrics/p1", "problems/p1"]);
  finishPosting(snapshot("p1", { title: "Research", proposalCount: 99, fundedAmount: 999 }));
  await expect(request).resolves.toMatchObject({ id: "p1", title: "Research", proposalCount: 4, fundedAmount: 20 });
});

it("preserves fallback counts without trusting historical client-authored funding totals", async () => {
  mocks.getDoc.mockImplementation(async ({ path }) => path.startsWith("problems/")
    ? snapshot("p1", { title: "Research", proposalCount: 2, fundedAmount: 999 }) : snapshot("p1", null));
  await expect(findPosting("p1")).resolves.toMatchObject({ proposalCount: 2, fundedAmount: 0, fundingProgressPercent: 0 });
});

it("preserves a missing record result even when its concurrent metrics read is denied", async () => {
  mocks.getDoc.mockImplementation(async ({ path }) => {
    if (path.startsWith("problems/")) return snapshot("p1", null);
    throw new Error("metrics denied");
  });
  await expect(findPosting("p1")).resolves.toBeNull();
});

it("preserves posting error precedence and explicit server reads", async () => {
  const denied = new Error("posting denied");
  mocks.getDoc.mockRejectedValue(new Error("metrics denied"));
  mocks.getDocFromServer.mockRejectedValue(denied);
  await expect(findPosting("p1", { fromServer: true })).rejects.toBe(denied);
  expect(mocks.getDocFromServer).toHaveBeenCalledWith({ path: "problems/p1" });
});

it("does not replace metric read failure with invented financial totals", async () => {
  const unavailable = new Error("metrics unavailable");
  mocks.getDoc.mockImplementation(async ({ path }) => {
    if (path.startsWith("problems/")) return snapshot("p1", { title: "Research" });
    throw unavailable;
  });
  await expect(findPosting("p1")).rejects.toBe(unavailable);
});

it("loads drafts using the wallet and status constraints without any legacy parent lookups", async () => {
  mocks.getDocs.mockResolvedValue({ docs: [snapshot("draft", { status: "draft", problemId: "parent", title: "Draft" })] });
  await expect(listProposals("researcherId", "0xABC", { draftsOnly: true })).resolves.toMatchObject([{ id: "draft", title: "Draft" }]);
  expect(mocks.getDocs).toHaveBeenCalledWith({ path: "proposals", constraints: [
    { field: "researcherId", op: "==", value: "0xabc" }, { field: "status", op: "==", value: "draft" },
  ] });
  expect(mocks.getDoc).not.toHaveBeenCalled();
});

it("retains the complete author list and legacy parent matching outside draft-only mode", async () => {
  mocks.getDocs.mockResolvedValue({ docs: [snapshot("submitted", { status: "submitted", problemId: "parent" })] });
  mocks.getDoc.mockResolvedValue(snapshot("parent", { matching: { status: "confirmed", proposalId: "another" } }));
  await expect(listProposals("researcherId", "0xABC")).resolves.toMatchObject([{ id: "submitted", matching: { status: "cancelled" } }]);
  expect(mocks.getDocs.mock.calls[0][0].constraints).toEqual([{ field: "researcherId", op: "==", value: "0xabc" }]);
});
