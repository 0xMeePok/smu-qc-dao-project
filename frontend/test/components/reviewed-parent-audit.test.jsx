import { describe, expect, it, vi } from "vitest";
import { captureReviewedParentAudit, assertReviewedParentAudit } from "../../src/lib/reviewedParentAudit.js";
import { AUDIT_REGISTRY_CONFIG } from "../../src/config/auditRegistry.js";
import { prepareOpportunityCommit } from "../../src/lib/auditRegistry.js";
import { postingAuditPayload, fundingOpportunityAuditPayload } from "../../../firebase/functions/opportunityAuditPayload.js";

function fixture(open = false) {
  const posting = { id: "reviewed-parent", ownerId: `0x${"a".repeat(40)}`, organisation: "Research lab",
    title: "The reviewed terms", summary: "Research challenge", amount: 2000, currency: "USDC",
    categories: ["quantum"], tags: ["research"], fundingThesis: "Quantum outcomes", eligibilityNotes: "Members",
    opportunityType: open ? "open-funding" : "business-problem", expiresAt: new Date("2099-01-01"), attachments: [] };
  const prepared = prepareOpportunityCommit({ recordId: posting.id,
    actor: AUDIT_REGISTRY_CONFIG.entityIdScheme === 2 ? posting.ownerId : undefined,
    payload: open ? fundingOpportunityAuditPayload(posting) : postingAuditPayload(posting), kind: open ? 1 : 0, expiresAt: posting.expiresAt });
  const readContract = vi.fn(async ({ functionName }) => functionName === "opportunityRevisionCount" ? 3n : { contentHash: prepared.contentHash });
  return { posting, prepared, options: { adapters: { readContract, writeContract: vi.fn(), waitForTransactionReceipt: vi.fn() } } };
}

describe("proposal author reviews an exact parent version", () => {
  it.each([false, true])("captures and retains the displayed document and chain revision (open=%s)", async open => {
    const { posting, prepared, options } = fixture(open);
    const reviewed = await captureReviewedParentAudit(posting, options);
    expect(reviewed).toEqual({ chainId: AUDIT_REGISTRY_CONFIG.chainId, contractAddress: AUDIT_REGISTRY_CONFIG.address.toLowerCase(),
      entityId: prepared.entityId, contentHash: prepared.contentHash, revisionIndex: 2, revisionDigest: prepared.contentHash });
    await expect(assertReviewedParentAudit({ ...posting }, reviewed, options)).resolves.toBeUndefined();
  });
  it("refuses a fresh parent document with changed terms before reading the chain or signing", async () => {
    const { posting, options } = fixture();
    const reviewed = await captureReviewedParentAudit(posting, options);
    options.adapters.readContract.mockClear();
    await expect(assertReviewedParentAudit({ ...posting, title: "Changed after review" }, reviewed, options)).rejects.toThrow(/changed since you reviewed/);
    expect(options.adapters.readContract).not.toHaveBeenCalled();
    expect(options.adapters.writeContract).not.toHaveBeenCalled();
  });
  it("refuses a later chain revision without changing the saved expected version", async () => {
    const { posting, prepared, options } = fixture();
    const reviewed = await captureReviewedParentAudit(posting, options);
    options.adapters.readContract.mockImplementation(async ({ functionName }) => functionName === "opportunityRevisionCount" ? 4n : { contentHash: prepared.contentHash });
    await expect(assertReviewedParentAudit(posting, reviewed, options)).rejects.toThrow(/changed since you reviewed/);
    expect(reviewed.revisionIndex).toBe(2);
    expect(options.adapters.writeContract).not.toHaveBeenCalled();
  });
  it("fails closed when the chain cannot confirm the reviewed parent", async () => {
    const { posting, options } = fixture();
    options.adapters.readContract.mockRejectedValue(new Error("Parent unavailable"));
    await expect(captureReviewedParentAudit(posting, { ...options, maxReadRetries: 0 })).rejects.toThrow(/Parent unavailable/);
    expect(options.adapters.writeContract).not.toHaveBeenCalled();
  });
});
