import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ updates: [], find: vi.fn(), failedStatuses: new Set() }));
vi.mock("../../src/lib/proposals.js", () => ({
  findProposal: (...args) => mocks.find(...args),
  updateProposalReceipt: async ({ audit }) => {
    mocks.updates.push(audit);
    if (mocks.failedStatuses.has(audit.status)) {
      throw new Error(`Unable to persist ${audit.status}.`);
    }
  },
}));
import { anchorProposalAudit, proposalAuditReceipt, proposalAuditPayload, readProposalAudit } from "../../src/lib/proposalAudit.js";
import { prepareProposalCommit } from "../../src/lib/auditRegistry.js";
const account = `0x${"a".repeat(40)}`;
const tx = `0x${"3".repeat(64)}`;
const record = { id: "proposal123", problemId: "problem123", researcherId: account, title: "Annealing", methodology: "Benchmark routing", attachments: [] };
const prepared = prepareProposalCommit({ recordId: record.id, opportunityRecordId: record.problemId, expectedOpportunityRevisionIndex: 0, proposalPayload: proposalAuditPayload(record), solutionPayload: { methodology: record.methodology, attachments: [] } });
function readContract({ functionName }) {
  if (functionName === "getProposal") return { researcher: account, opportunityId: prepared.opportunityId, opportunityRevisionIndex: 0, proposalHash: prepared.proposalHash, solutionHash: prepared.solutionHash };
  if (functionName === "revisionCount") return mocks.revisions;
  if (functionName === "anchorCount") return 1n;
  if (functionName === "anchorAt") return { contentHash: prepared.anchorHash };
  throw new Error(`Unexpected read: ${functionName}`);
}
beforeEach(() => {
  mocks.updates = [];
  mocks.revisions = 0n;
  mocks.failedStatuses.clear();
});
describe("proposal audit handoff", () => {
  it("supports fractional token amounts without rejecting the saved proposal", () => {
    expect(proposalAuditReceipt({ ...record, amount: 1500.25 }).contentHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(proposalAuditPayload({ ...record, amount: 1500.25 }).amount).toBe("1500.25");
  });
  it("anchors the proposal and solution against the linked opportunity", async () => {
    const writeContract = vi.fn(async () => tx);
    const result = await anchorProposalAudit(record, { account, adapters: { writeContract, readContract, waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 88n }) } });
    expect(writeContract.mock.calls[0][0].functionName).toBe("commitProposal");
    expect(mocks.updates.map((audit) => audit.status)).toEqual(["queued", "submitted", "pending", "confirmed"]);
    expect(result.status).toBe("confirmed");
    expect(result.transactionHash).toBe(tx);
  });
  it("QCDAO-57 amends an already-anchored proposal instead of committing it twice", async () => {
    // commitProposal reverts once the entity id is taken, so a corrected
    // proposal has to go to updateHashes - which appends a revision beside the
    // original rather than replacing it. The chain is what decides, because a
    // dropped or never-saved receipt would make Firestore the wrong source.
    mocks.revisions = 1n;
    const writeContract = vi.fn(async () => tx);
    const result = await anchorProposalAudit(record, { account, adapters: { writeContract, readContract, waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 91n }) } });
    const call = writeContract.mock.calls[0][0];
    expect(call.functionName).toBe("updateHashes");
    // The same hashes either way; only the call that carries them differs.
    expect(call.args).toEqual([prepared.entityId, prepared.proposalHash, prepared.solutionHash, 0]);
    expect(result.status).toBe("confirmed");
  });
  it("records a retryable failure when the wallet rejects without deleting the saved proposal", async () => {
    await expect(anchorProposalAudit(record, { account, adapters: { writeContract: async () => { throw Object.assign(new Error("User rejected"), { code: 4001 }); }, readContract, waitForTransactionReceipt: vi.fn() } })).rejects.toThrow();
    expect(mocks.updates.at(-1).status).toBe("failed");
    expect(mocks.updates.at(-1).transactionHash).toBe("");
  });
  it("explains a fee rejection without treating it as an opportunity-state revert", async () => {
    await expect(anchorProposalAudit(record, { account, adapters: {
      writeContract: async () => { throw new Error("commitProposal reverted: max fee per gas less than block base fee"); },
      readContract, waitForTransactionReceipt: vi.fn(),
    } })).rejects.toThrow();
    expect(mocks.updates.at(-1).status).toBe("failed");
    expect(mocks.updates.at(-1).lastError).toMatch(/Network fees rose.*fresh fee estimate/);
    expect(mocks.updates.at(-1).transactionHash).toBe("");
  });
  it("recovers a known transaction without rebroadcasting", async () => {
    const writeContract = vi.fn();
    const result = await anchorProposalAudit({ ...record, audit: { ...proposalAuditReceipt(record), status: "pending", transactionHash: tx } }, { account, adapters: { writeContract, readContract, waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 99n }) } });
    expect(writeContract).not.toHaveBeenCalled();
    expect(mocks.updates.map((audit) => audit.status)).toContain("confirmed");
    expect(result.status).toBe("confirmed");
  });
  it("keeps a mined proposal pending until trusted server confirmation", async () => {
    mocks.failedStatuses.add("confirmed");
    const onChange = vi.fn();
    const result = await anchorProposalAudit(record, {
      account,
      onChange,
      adapters: {
        writeContract: async () => tx,
        readContract,
        waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 88n }),
      },
    });
    expect(result.status).toBe("pending");
    expect(result.lastError).toMatch(/trusted server confirmation is still pending/i);
    expect(onChange.mock.calls.map(([audit]) => audit.status)).not.toContain("confirmed");
  });
  it("preserves transaction recovery guidance when confirmation persistence fails", async () => {
    mocks.failedStatuses.add("pending");
    mocks.failedStatuses.add("confirmed");
    const result = await anchorProposalAudit(record, {
      account,
      adapters: {
        writeContract: async () => tx,
        readContract,
        waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 88n }),
      },
    });
    expect(result.status).toBe("pending");
    expect(result.transactionHash).toBe(tx);
    expect(result.lastError).toMatch(/receipt could not be saved/i);
    expect(result.lastError).toMatch(/retry verification/i);
  });
});

it("re-verifies a fresh server read and detects a changed proposal", async () => {
  mocks.find.mockResolvedValue({ ...record, title: "Tampered" });
  const result = await readProposalAudit(record, { adapters: { readContract, writeContract: vi.fn(), waitForTransactionReceipt: vi.fn() } });
  expect(mocks.find).toHaveBeenCalledWith(record.id, { fromServer: true });
  expect(result.verified).toBe(false);
});
it("does not broadcast beyond the wallet attempt cap", async () => {
  const writeContract = vi.fn();
  await expect(anchorProposalAudit({ ...record, audit: { attemptCount: 3 } }, { account, adapters: { writeContract, readContract, waitForTransactionReceipt: vi.fn() } })).rejects.toThrow(/limit/);
  expect(writeContract).not.toHaveBeenCalled();
});
it("does not treat an unsupported schema as a verified v1 receipt", () => {
  expect(proposalAuditReceipt({ ...record, audit: { schemaVersion: 2 } })).toBeNull();
});
