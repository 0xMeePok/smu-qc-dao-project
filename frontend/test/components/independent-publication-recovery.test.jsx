import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn() }));
vi.mock("../../src/lib/proposals.js", async importOriginal => ({
  ...await importOriginal(), findProposal: (...args) => mocks.find(...args),
  updateProposalReceipt: (...args) => mocks.update(...args),
}));
import { buildIndependentProposalDocument } from "../../src/lib/proposals.js";
import { anchorProposalBeforeWrite } from "../../src/lib/proposalAudit.js";
import { AUDIT_REGISTRY_CONFIG } from "../../src/config/auditRegistry.js";
import { prepareStoredProposal } from "../../../firebase/functions/proposalAuditPayload.js";

const account = `0x${"a".repeat(40)}`;
const listingHash = `0x${"1".repeat(64)}`;
const networkError = () => new Error("HTTP 503: RPC provider unavailable");

function fixture() {
  const record = { id: "independent-recovery", ...buildIndependentProposalDocument({
    researcherId: account, expiresAt: new Date("2099-01-01"),
    form: { title: "Independent solution", summary: "Summary", methodology: "Method",
      addressedProblems: "Routing", maturity: "pilot", category: "quantum-annealing", team: "Researchers",
      amount: "100", currency: "USDC", reviewDays: "7", funderVoting: false },
  }) };
  const listing = prepareStoredProposal(record);
  const state = { opportunityRevisions: 0n, failListingReceipt: false, listingReverted: false };
  const writeContract = vi.fn(async request => {
    if (request.functionName !== "commitOpportunity") throw new Error(`Unexpected write ${request.functionName}`);
    state.opportunityRevisions = 1n;
    return listingHash;
  });
  const readContract = vi.fn(async ({ functionName }) => {
    if (functionName === "opportunityRevisionCount") return state.opportunityRevisions;
    if (functionName === "getOpportunity") return { owner: account, kind: 2,
      contentHash: listing.contentHash, expiresAt: listing.args[3] };
    if (functionName === "anchorCount") return 1n;
    if (functionName === "anchorAt") return { contentHash: listing.anchorHash };
    throw new Error(`Unexpected read ${functionName}`);
  });
  const waitForTransactionReceipt = vi.fn(async ({ hash }) => {
    if (hash === listingHash && state.failListingReceipt) throw networkError();
    return { status: hash === listingHash && state.listingReverted ? "reverted" : "success", blockNumber: 88n, transactionHash: hash };
  });
  const getTransaction = vi.fn(async ({ hash }) => ({
    hash, from: account, to: AUDIT_REGISTRY_CONFIG.address, chainId: AUDIT_REGISTRY_CONFIG.chainId,
  }));
  const adapters = { writeContract, readContract, waitForTransactionReceipt, getTransaction };
  const changes = [];
  const options = { account, adapters, maxReceiptRetries: 0, maxReadRetries: 0, onChange: next => changes.push(next) };
  return { record, state, options, adapters, changes };
}

async function failure(operation) {
  try { await operation; } catch (error) { return error; }
  throw new Error("Expected publication to fail");
}

beforeEach(() => { mocks.find.mockResolvedValue(null); mocks.update.mockReset(); });

describe("independent publication transaction recovery", () => {
  it("returns after the listing transaction and does not request an escrow signature", async () => {
    const f = fixture();
    const audit = await anchorProposalBeforeWrite(f.record, f.options);
    expect(audit).toMatchObject({ status: "confirmed", transactionHash: listingHash });
    expect(f.adapters.writeContract.mock.calls.map(([call]) => call.functionName)).toEqual(["commitOpportunity"]);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("retains the submitted listing hash through a receipt outage and reuses it", async () => {
    const f = fixture(); f.state.failListingReceipt = true;
    const error = await failure(anchorProposalBeforeWrite(f.record, f.options));
    expect(error.listingAudit.transactionHash).toBe(listingHash);
    expect(f.adapters.writeContract).toHaveBeenCalledOnce();
    f.state.failListingReceipt = false;
    const audit = await anchorProposalBeforeWrite({ ...f.record, audit: error.listingAudit }, f.options);
    expect(audit).toMatchObject({ status: "confirmed", transactionHash: listingHash });
    expect(f.adapters.writeContract).toHaveBeenCalledOnce();
  });

  it("saves a listing that is already anchored without asking for another signature", async () => {
    const f = fixture();
    const first = await anchorProposalBeforeWrite(f.record, f.options);
    const again = await anchorProposalBeforeWrite({ ...f.record, audit: first }, f.options);
    expect(again).toMatchObject({ status: "confirmed", transactionHash: listingHash });
    expect(f.adapters.writeContract).toHaveBeenCalledOnce();
  });

  it("clears a conclusively reverted listing transaction", async () => {
    const f = fixture(); f.state.listingReverted = true;
    const error = await failure(anchorProposalBeforeWrite(f.record, f.options));
    expect(error.receipt.status).toBe("reverted");
    expect(error.listingAudit).toBeUndefined();
    expect(f.changes.at(-1).transactionHash).toBe("");
    expect(f.adapters.writeContract).toHaveBeenCalledOnce();
  });
});
