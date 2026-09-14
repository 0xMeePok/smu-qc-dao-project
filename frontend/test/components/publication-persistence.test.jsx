import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ attest: vi.fn(), set: vi.fn(), update: vi.fn(), parent: null }));
vi.mock("../../src/lib/firebase.js", () => ({ db: {} }));
vi.mock("../../src/lib/authFlow.js", () => ({ requireFirebase: () => {} }));
vi.mock("../../src/lib/attachments.js", () => ({ toPostingRecord: (value) => value, deleteAttachment: vi.fn() }));
vi.mock("../../src/lib/publication.js", () => ({ attestPublication: mocks.attest, reserveResource: vi.fn() }));
vi.mock("firebase/firestore", async (importOriginal) => ({
  ...await importOriginal(),
  doc: (_db, ...parts) => ({ path: parts.join("/") }),
  setDoc: mocks.set, updateDoc: mocks.update,
  getDoc: async () => ({ exists: () => false }),
  runTransaction: async (_db, callback) => callback({
    get: async (ref) => ({ exists: () => ref.path === "problems/parent", id: "parent", data: () => mocks.parent }),
    set: mocks.set, update: mocks.update,
  }),
}));
import { Timestamp } from "firebase/firestore";
import { createPosting, publishDraft } from "../../src/lib/postings.js";
import { createFundingOpportunity, publishFundingDraft } from "../../src/lib/fundingOpportunities.js";
import { buildProposalDocument, submitProposal } from "../../src/lib/proposals.js";
import { PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS } from "../../src/config/proposal.js";
const writers = [
  { name: "new funded problem", write: createPosting, draft: false },
  { name: "funded problem draft promotion", write: publishDraft, draft: true },
  { name: "new open funding opportunity", write: createFundingOpportunity, draft: false },
  { name: "open funding draft promotion", write: publishFundingDraft, draft: true },
];
const receipt = () => ({ status: "pending", transactionHash: `0x${"a".repeat(64)}`, blockNumber: 123 });
const preparedRecord = () => ({
  ownerId: `0x${"b".repeat(40)}`, title: "The exact anchored version", status: "submitted",
  expiresAt: Timestamp.fromDate(new Date("2099-01-01T00:00:00Z")),
  createdAt: Timestamp.fromDate(new Date("2026-09-14T00:00:00Z")),
  updatedAt: Timestamp.fromDate(new Date("2026-09-14T00:00:01Z")), attachments: [],
});

describe("proposal publication persists its attested receipt atomically", () => {
  for (const openFunding of [false, true]) for (const fromDraft of [false, true]) {
    it(`keeps receipt, content, and author slot together (open=${openFunding}, draft=${fromDraft})`, async () => {
      const researcherId = `0x${"b".repeat(40)}`;
      const posting = { id: "parent", ownerId: `0x${"c".repeat(40)}`, currency: "USDC", status: "submitted",
        opportunityType: openFunding ? "open-funding" : "business-problem", expiresAt: new Date("2099-01-01") };
      mocks.parent = posting;
      const form = { ...Object.fromEntries([...PROPOSAL_FIELDS, ...PROBLEM_FRAMING_FIELDS].map(([key]) => [key, `${key} content`])), category: "quantum-annealing", amount: "1000" };
      const attachments = ["attachment01", "attachment02"].map((id) => ({ id, name: `${id}.pdf`, size: 10, contentType: "application/pdf", sha256: `0x${"1".repeat(64)}` }));
      const record = buildProposalDocument({ researcherId, posting, form, attachments }), audit = receipt();
      await submitProposal({ proposalId: "proposal1", researcherId, posting, form, attachments, record, audit, fromDraft });
      const attested = mocks.attest.mock.calls[0][2];
      const persisted = (fromDraft ? mocks.update : mocks.set).mock.calls.find(([ref]) => ref.path === "proposals/proposal1")[1];
      expect(attested.audit).toEqual(audit);
      expect(persisted.audit).toEqual(attested.audit);
      expect(persisted.attachments).toEqual(attested.attachments);
      expect(persisted.audit.status).toBe("pending");
      expect(mocks.set.mock.calls.some(([ref]) => ref.path === `problems/parent/proposalAuthors/${researcherId}`)).toBe(true);
      if (fromDraft) expect(persisted).not.toHaveProperty("createdAt");
    });
  }
});
beforeEach(() => { vi.resetAllMocks(); });
describe("publication proof and persisted receipt stay bound", () => {
  for (const { name, write, draft } of writers) {
    it(`${name} writes the same mined receipt and content that the server attests`, async () => {
      const record = preparedRecord(), audit = receipt();
      await write({ postingId: "p1", opportunityId: "p1", record, audit });
      const persisted = (draft ? mocks.update : mocks.set).mock.calls[0][1];
      expect(mocks.attest).toHaveBeenCalledWith("problems", "p1", persisted);
      expect(persisted.audit).toEqual(audit);
      // Only the server may promote pending to confirmed.
      expect(persisted.audit.status).toBe("pending");
      expect(persisted.expiresAt).toBe(record.expiresAt);
      expect(persisted.title).toBe(record.title);
      expect(record).not.toHaveProperty("audit");
      if (draft) expect(persisted).not.toHaveProperty("createdAt");
      else expect(persisted.createdAt).toBe(record.createdAt);
    });
    it(`${name} preserves an existing supplied receipt when no separate audit is passed`, async () => {
      const record = { ...preparedRecord(), audit: receipt() };
      await write({ postingId: "p2", opportunityId: "p2", record });
      const persisted = (draft ? mocks.update : mocks.set).mock.calls[0][1];
      expect(persisted.audit).toEqual(record.audit);
      expect(mocks.attest).toHaveBeenCalledWith("problems", "p2", persisted);
    });
    it(`${name} never writes when server attestation fails`, async () => {
      mocks.attest.mockRejectedValueOnce(new Error("The mined transaction did not match"));
      await expect(write({ postingId: "p3", opportunityId: "p3", record: preparedRecord(), audit: receipt() }))
        .rejects.toThrow("The mined transaction did not match");
      expect(mocks.set).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    });
  }
});
