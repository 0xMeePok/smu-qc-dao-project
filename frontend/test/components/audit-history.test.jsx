import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proposal: null, posting: null, saved: [] }));
vi.mock("../../src/lib/proposals.js", () => ({
  findProposal: async () => mocks.proposal,
  updateProposalReceipt: async ({ audit }) => { mocks.saved.push(audit); },
}));
vi.mock("../../src/lib/postings.js", async () => ({
  findPosting: async () => mocks.posting,
  postingAuditPayload: (await import("../../../firebase/functions/opportunityAuditPayload.js")).postingAuditPayload,
  updatePostingAudit: vi.fn(),
}));

import legacy from "../../../contracts/audit-registry/legacy/pre-escrow-arbitrumSepolia.contract.json" with { type: "json" };
import { AUDIT_REGISTRY_CONFIG } from "../../src/config/auditRegistry.js";
import { prepareStoredProposal } from "../../../firebase/functions/proposalAuditPayload.js";
import { preparePostingAudit, readPostingAudit } from "../../src/lib/postingAudit.js";
import { anchorProposalAudit, anchorProposalBeforeWrite, anchorProposalWithdrawal, proposalAuditReceipt, readProposalAudit } from "../../src/lib/proposalAudit.js";

const account = `0x${"a".repeat(40)}`;
const hash = `0x${"3".repeat(64)}`;
const proposal = { id: "historical-proposal", problemId: "historical-posting", researcherId: account,
  postingOwnerId: `0x${"b".repeat(40)}`, title: "Original proposal", summary: "Original summary",
  methodology: "Original method", attachments: [], amount: 100, currency: "USDC" };
const prepared = prepareStoredProposal(proposal, { registryConfig: legacy });
const audit = { schemaVersion: 1, chainId: 421614, entityId: prepared.entityId, contentHash: prepared.contentHash,
  status: "confirmed", transactionHash: hash, blockNumber: 88, attemptCount: 1, lastError: "" };

function adaptersFor(expected) {
  return {
    getTransaction: vi.fn(async () => ({ hash, to: legacy.address, chainId: 421614 })),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 88n })),
    writeContract: vi.fn(() => { throw new Error("Historical record must not be written"); }),
    readContract: vi.fn(async ({ address, functionName }) => {
      expect(address.toLowerCase()).toBe(legacy.address.toLowerCase());
      if (functionName === "getProposal") return { researcher: account, opportunityId: expected.opportunityId,
        opportunityRevisionIndex: 0n, proposalHash: expected.proposalHash, solutionHash: expected.solutionHash };
      if (functionName === "getOpportunity") return { owner: expected.expectedOwner, kind: expected.args[1],
        contentHash: expected.contentHash, expiresAt: expected.args[3] };
      if (functionName === "anchorCount") return 1n;
      if (functionName === "anchorAt") return { contentHash: expected.anchorHash };
      throw new Error(`Unexpected historical read ${functionName}`);
    }),
  };
}

beforeEach(() => {
  mocks.proposal = { ...proposal, audit };
  mocks.saved = [];
});

describe("Historical audit reads after escrow deployment cutover", () => {
  it("keeps the old proposal receipt visible and verifies without requiring escrow terms", async () => {
    expect(AUDIT_REGISTRY_CONFIG.contractName).toBe("EscrowAuditRegistry");
    expect(proposalAuditReceipt(mocks.proposal)).toEqual(audit);
    const adapters = adaptersFor(prepared);
    expect((await readProposalAudit(mocks.proposal, { adapters })).verified).toBe(true);
    expect(adapters.readContract.mock.calls.some(([request]) => request.functionName === "fundingFactory")).toBe(false);
    expect(adapters.writeContract).not.toHaveBeenCalled();
  });

  it("recomputes historical hashes from the latest server document", async () => {
    const pageRecord = mocks.proposal;
    mocks.proposal = { ...mocks.proposal, title: "Changed after anchoring" };
    const result = await readProposalAudit(pageRecord, { adapters: adaptersFor(prepared) });
    expect(result.verified).toBe(false);
    expect(result.mismatches.map(item => item.field)).toContain("proposalHash");
  });

  it("reads a historical posting on its original registry", async () => {
    const posting = { id: proposal.problemId, ownerId: proposal.postingOwnerId, title: "Original posting",
      summary: "Original description", amount: 100, currency: "USDC", attachments: [], expiresAt: new Date("2026-12-01") };
    const expected = preparePostingAudit(posting, { registryConfig: legacy }).prepared;
    mocks.posting = { ...posting, audit: { ...audit, entityId: expected.entityId, contentHash: expected.contentHash } };
    expect((await readPostingAudit(mocks.posting, { adapters: adaptersFor(expected) })).verified).toBe(true);
  });

  it("recovers an existing historical receipt without rebroadcasting or adding receipt fields", async () => {
    const adapters = adaptersFor(prepared);
    const result = await anchorProposalAudit({ ...mocks.proposal, audit: { ...audit, status: "pending" } }, { account, adapters });
    expect(result.status).toBe("confirmed");
    expect(Object.keys(result)).toHaveLength(9);
    expect(adapters.writeContract).not.toHaveBeenCalled();
    expect(mocks.saved.at(-1).entityId).toBe(prepared.entityId);
  });

  it("rejects historical edits and withdrawals before opening the wallet", async () => {
    const adapters = adaptersFor(prepared);
    await expect(anchorProposalBeforeWrite(mocks.proposal, { account, adapters })).rejects.toThrow(/earlier.*read-only/);
    await expect(anchorProposalWithdrawal(mocks.proposal, { account, adapters, reason: "Changed requirements" })).rejects.toThrow(/earlier.*read-only/);
    expect(adapters.writeContract).not.toHaveBeenCalled();
    expect(mocks.saved).toHaveLength(0);
  });

  it("does not reanchor a historical edit whose form cleared the old receipt", async () => {
    const adapters = adaptersFor(prepared);
    await expect(anchorProposalBeforeWrite({ ...proposal, title: "Edited proposal" }, { account, adapters }))
      .rejects.toThrow(/earlier.*read-only/);
    expect(adapters.writeContract).not.toHaveBeenCalled();
    expect(mocks.saved).toHaveLength(0);
  });

  it("rejects an unknown deployment instead of probing the active registry", async () => {
    const adapters = adaptersFor(prepared);
    adapters.getTransaction.mockResolvedValue({ hash, to: `0x${"d".repeat(40)}`, chainId: 421614 });
    await expect(readProposalAudit(mocks.proposal, { adapters })).rejects.toThrow(/known AuditRegistry/);
    expect(adapters.readContract).not.toHaveBeenCalled();
  });
});
