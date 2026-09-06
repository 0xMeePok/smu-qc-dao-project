import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ updates: [] }));
vi.mock("../../src/lib/proposals.js", () => ({ updateProposalReceipt: async ({ audit }) => mocks.updates.push(audit) }));
import { anchorProposalAudit, proposalAuditReceipt, proposalAuditPayload } from "../../src/lib/proposalAudit.js";
import { prepareProposalCommit } from "../../src/lib/auditRegistry.js";
const account = `0x${"a".repeat(40)}`;
const tx = `0x${"3".repeat(64)}`;
const record = { id: "proposal123", problemId: "problem123", researcherId: account, title: "Annealing", methodology: "Benchmark routing", attachments: [] };
const prepared = prepareProposalCommit({ recordId: record.id, opportunityRecordId: record.problemId, expectedOpportunityRevisionIndex: 0, proposalPayload: proposalAuditPayload(record), solutionPayload: { methodology: record.methodology, attachments: [] } });
function readContract({ functionName }) {
  if (functionName === "getProposal") return { opportunityId: prepared.opportunityId, opportunityRevisionIndex: 0, proposalHash: prepared.proposalHash, solutionHash: prepared.solutionHash };
  if (functionName === "anchorCount") return 1n;
  if (functionName === "anchorAt") return { contentHash: prepared.anchorHash };
  throw new Error(`Unexpected read: ${functionName}`);
}
beforeEach(() => { mocks.updates = []; });
describe("proposal audit handoff", () => {
  it("supports fractional token amounts without rejecting the saved proposal", () => {
    expect(proposalAuditReceipt({ ...record, amount: 1500.25 }).contentHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(proposalAuditPayload({ ...record, amount: 1500.25 }).amount).toBe("1500.25");
  });
  it("anchors the proposal and solution against the linked opportunity", async () => {
    const writeContract = vi.fn(async () => tx);
    const result = await anchorProposalAudit(record, { account, adapters: { writeContract, readContract, waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 88n }) } });
    expect(writeContract.mock.calls[0][0].functionName).toBe("commitProposal");
    expect(mocks.updates.map((audit) => audit.status)).toEqual(["queued", "submitted", "pending"]);
    expect(result.status).toBe("confirmed");
    expect(result.transactionHash).toBe(tx);
  });
  it("records a retryable failure when the wallet rejects without deleting the saved proposal", async () => {
    await expect(anchorProposalAudit(record, { account, adapters: { writeContract: async () => { throw Object.assign(new Error("User rejected"), { code: 4001 }); }, readContract } })).rejects.toThrow();
    expect(mocks.updates.at(-1).status).toBe("failed");
    expect(mocks.updates.at(-1).transactionHash).toBe("");
  });
  it("recovers a known transaction without rebroadcasting", async () => {
    const writeContract = vi.fn();
    const result = await anchorProposalAudit({ ...record, audit: { ...proposalAuditReceipt(record), status: "pending", transactionHash: tx } }, { account, adapters: { writeContract, readContract, waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 99n }) } });
    expect(writeContract).not.toHaveBeenCalled();
    expect(mocks.updates.map((audit) => audit.status)).not.toContain("confirmed");
    expect(result.status).toBe("confirmed");
  });
});
