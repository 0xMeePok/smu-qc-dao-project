import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData } from "viem";

const mocks = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn() }));
vi.mock("../../src/lib/proposals.js", async importOriginal => ({
  ...await importOriginal(), findProposal: (...args) => mocks.find(...args),
  updateProposalReceipt: (...args) => mocks.update(...args),
}));
import { buildIndependentProposalDocument } from "../../src/lib/proposals.js";
import { anchorProposalBeforeWrite } from "../../src/lib/proposalAudit.js";
import { AUDIT_REGISTRY_ABI, AUDIT_REGISTRY_CONFIG } from "../../src/config/auditRegistry.js";
import { prepareIndependentEscrowCommit, prepareStoredProposal } from "../../../firebase/functions/proposalAuditPayload.js";

const account = `0x${"a".repeat(40)}`;
const listingHash = `0x${"1".repeat(64)}`;
const escrowHash = `0x${"2".repeat(64)}`;
const networkError = () => new Error("HTTP 503: RPC provider unavailable");

function fixture() {
  const record = { id: "independent-recovery", ...buildIndependentProposalDocument({
    researcherId: account, expiresAt: new Date("2099-01-01"),
    form: { title: "Independent solution", summary: "Summary", methodology: "Method",
      addressedProblems: "Routing", maturity: "pilot", category: "quantum-annealing", team: "Researchers",
      amount: "100", currency: "USDC", reviewDays: "7", funderVoting: false },
  }) };
  const listing = prepareStoredProposal(record), escrow = prepareIndependentEscrowCommit(record);
  const state = { opportunityRevisions: 0n, proposalRevisions: 0n, failSignature: false,
    failListingReceipt: false, failEscrowReceipt: false, cancelled: false, reverted: false, changedInput: false,
    listingReverted: false, changedRevision: false, failListingTransaction: false, transactionOverrides: {} };
  const transactions = new Map();
  const writeContract = vi.fn(async request => {
    if (request.functionName === "commitOpportunity") {
      state.opportunityRevisions = 1n;
      return listingHash;
    }
    if (state.failSignature) throw Object.assign(new Error("User rejected escrow signature"), { code: 4001 });
    state.proposalRevisions = 1n;
    transactions.set(escrowHash, request);
    return escrowHash;
  });
  const readContract = vi.fn(async ({ functionName }) => {
    if (functionName === "opportunityRevisionCount") return state.changedRevision ? 2n : state.opportunityRevisions;
    if (functionName === "revisionCount") return state.proposalRevisions;
    if (functionName === "getOpportunity") return { owner: account, kind: 2,
      contentHash: listing.contentHash, expiresAt: listing.args[3] };
    if (functionName === "anchorCount") return 1n;
    if (functionName === "anchorAt") return { contentHash: listing.anchorHash };
    if (functionName === "getProposal") return { proposalHash: escrow.proposalHash, solutionHash: escrow.solutionHash };
    throw new Error(`Unexpected read ${functionName}`);
  });
  const waitForTransactionReceipt = vi.fn(async ({ hash, onReplaced }) => {
    if ((hash === listingHash && state.failListingReceipt) || (hash === escrowHash && state.failEscrowReceipt)) throw networkError();
    if (hash === escrowHash && state.cancelled) onReplaced({ reason: "cancelled" });
    return { status: (hash === escrowHash && state.reverted) || (hash === listingHash && state.listingReverted) ? "reverted" : "success", blockNumber: 88n, transactionHash: hash };
  });
  const getTransaction = vi.fn(async ({ hash }) => {
    if (hash === listingHash && state.failListingTransaction) throw networkError();
    const request = transactions.get(hash);
    return { hash, from: account, to: AUDIT_REGISTRY_CONFIG.address, chainId: AUDIT_REGISTRY_CONFIG.chainId,
      input: request ? (state.changedInput ? "0x1234" : encodeFunctionData({ abi: AUDIT_REGISTRY_ABI,
        functionName: request.functionName, args: request.args })) : "0x", ...(hash === escrowHash ? state.transactionOverrides : {}) };
  });
  const adapters = { writeContract, readContract, waitForTransactionReceipt, getTransaction };
  const changes = [], escrowChanges = [];
  const options = { account, adapters, maxReceiptRetries: 0, maxReadRetries: 0,
    onChange: next => changes.push(next), onEscrowChange: next => escrowChanges.push(next) };
  return { record, state, options, adapters, changes, escrowChanges };
}

async function failure(operation) {
  try { await operation; } catch (error) { return error; }
  throw new Error("Expected publication to fail");
}

beforeEach(() => { mocks.find.mockResolvedValue(null); mocks.update.mockReset(); });

describe("independent publication transaction recovery", () => {
  it("confirms both chain steps before returning the listing receipt without writing a Firestore receipt", async () => {
    const f = fixture();
    const audit = await anchorProposalBeforeWrite(f.record, f.options);
    expect(audit).toMatchObject({ status: "confirmed", transactionHash: listingHash });
    expect(f.adapters.writeContract.mock.calls.map(([call]) => call.functionName)).toEqual(["commitOpportunity", "commitProposalWithEscrow"]);
    expect(f.escrowChanges.at(-1)).toMatchObject({ status: "confirmed", transactionHash: escrowHash });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("retains the first submitted hash through a receipt outage and never requests the escrow signature yet", async () => {
    const f = fixture(); f.state.failListingReceipt = true;
    const error = await failure(anchorProposalBeforeWrite(f.record, f.options));
    expect(error.listingAudit.transactionHash).toBe(listingHash);
    expect(f.adapters.writeContract).toHaveBeenCalledOnce();
    expect(f.escrowChanges).toHaveLength(0);
    f.state.failListingReceipt = false;
    await anchorProposalBeforeWrite({ ...f.record, audit: error.listingAudit }, f.options);
    expect(f.adapters.writeContract.mock.calls.map(([call]) => call.functionName)).toEqual(["commitOpportunity", "commitProposalWithEscrow"]);
  });

  it("reuses the confirmed listing after the second signature is declined", async () => {
    const f = fixture(); f.state.failSignature = true;
    const error = await failure(anchorProposalBeforeWrite(f.record, f.options));
    expect(error.listingAudit).toMatchObject({ status: "confirmed", transactionHash: listingHash });
    expect(error.escrowAudit.transactionHash).toBe("");
    f.state.failSignature = false;
    await anchorProposalBeforeWrite({ ...f.record, audit: error.listingAudit }, { ...f.options, escrowAudit: error.escrowAudit });
    expect(f.adapters.writeContract.mock.calls.filter(([call]) => call.functionName === "commitOpportunity")).toHaveLength(1);
    expect(f.escrowChanges.at(-1).status).toBe("confirmed");
  });

  it("clears a conclusively reverted first transaction and does not proceed to escrow", async () => {
    const f = fixture(); f.state.listingReverted = true;
    const error = await failure(anchorProposalBeforeWrite(f.record, f.options));
    expect(error.receipt.status).toBe("reverted");
    expect(error.listingAudit).toBeUndefined();
    expect(f.changes.at(-1).transactionHash).toBe("");
    expect(f.adapters.writeContract).toHaveBeenCalledOnce();
    expect(f.escrowChanges).toHaveLength(0);
  });

  it("polls and validates the same escrow transaction after an ambiguous receipt outage, without signing again", async () => {
    const f = fixture(); f.state.failEscrowReceipt = true;
    const error = await failure(anchorProposalBeforeWrite(f.record, f.options));
    expect(error.escrowAudit.transactionHash).toBe(escrowHash);
    expect(error.listingAudit.status).toBe("confirmed");
    const writes = f.adapters.writeContract.mock.calls.length;
    await failure(anchorProposalBeforeWrite({ ...f.record, audit: error.listingAudit }, { ...f.options, escrowAudit: error.escrowAudit }));
    expect(f.adapters.writeContract).toHaveBeenCalledTimes(writes);
    f.state.failEscrowReceipt = false;
    const result = await anchorProposalBeforeWrite({ ...f.record, audit: error.listingAudit }, { ...f.options, escrowAudit: error.escrowAudit });
    expect(result.status).toBe("confirmed");
    expect(f.adapters.writeContract).toHaveBeenCalledTimes(writes);
    expect(f.adapters.getTransaction).toHaveBeenCalledWith({ hash: escrowHash, chainId: AUDIT_REGISTRY_CONFIG.chainId });
  });

  it("derives the expected calldata from the proposal instead of trusting a saved calldata field", async () => {
    const f = fixture(); f.state.failEscrowReceipt = true;
    const error = await failure(anchorProposalBeforeWrite(f.record, f.options));
    f.state.failEscrowReceipt = false; f.state.changedInput = true;
    const retryError = await failure(anchorProposalBeforeWrite({ ...f.record, audit: error.listingAudit }, {
      ...f.options, escrowAudit: { ...error.escrowAudit, callData: "0x1234" },
    }));
    expect(retryError.message).toMatch(/does not match/);
    expect(retryError.escrowAudit.transactionHash).toBe(escrowHash);
    expect(f.adapters.writeContract).toHaveBeenCalledTimes(2);
  });

  it("retains the unresolved escrow hash if rechecking the listing fails on a later retry", async () => {
    const f = fixture(); f.state.failEscrowReceipt = true;
    const first = await failure(anchorProposalBeforeWrite(f.record, f.options));
    f.state.failListingTransaction = true;
    const retry = await failure(anchorProposalBeforeWrite({ ...f.record, audit: first.listingAudit }, { ...f.options, escrowAudit: first.escrowAudit }));
    expect(retry.listingAudit.transactionHash).toBe(listingHash);
    expect(retry.escrowAudit.transactionHash).toBe(escrowHash);
    expect(f.adapters.writeContract).toHaveBeenCalledTimes(2);
  });

  it.each(["payment plan", "parent revision"])("refuses a changed %s while an escrow transaction is unresolved", async field => {
    const f = fixture(); f.state.failEscrowReceipt = true;
    const error = await failure(anchorProposalBeforeWrite(f.record, f.options));
    if (field === "parent revision") f.state.changedRevision = true;
    const changed = field === "payment plan" ? { ...f.record, fundingTerms: { ...f.record.fundingTerms, funderVoting: true } } : f.record;
    const retryError = await failure(anchorProposalBeforeWrite({ ...changed, audit: error.listingAudit }, { ...f.options, escrowAudit: error.escrowAudit }));
    expect(retryError.message).toMatch(/before changing/);
    expect(f.adapters.writeContract).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["registry", { to: `0x${"f".repeat(40)}` }],
    ["researcher", { from: `0x${"f".repeat(40)}` }],
    ["chain", { chainId: 1 }],
  ])("refuses a recovered receipt from a different %s", async (_label, overrides) => {
    const f = fixture(); f.state.failEscrowReceipt = true;
    const error = await failure(anchorProposalBeforeWrite(f.record, f.options));
    f.state.failEscrowReceipt = false; f.state.transactionOverrides = overrides;
    const retryError = await failure(anchorProposalBeforeWrite({ ...f.record, audit: error.listingAudit }, { ...f.options, escrowAudit: error.escrowAudit }));
    expect(retryError.message).toMatch(/does not match/);
    expect(retryError.escrowAudit.transactionHash).toBe(escrowHash);
    expect(f.adapters.writeContract).toHaveBeenCalledTimes(2);
  });

  it.each(["cancelled", "reverted"])("permits a new escrow signature only after a known %s result", async result => {
    const f = fixture(); f.state.failEscrowReceipt = true;
    const first = await failure(anchorProposalBeforeWrite(f.record, f.options));
    f.state.failEscrowReceipt = false; f.state[result] = true;
    const known = await failure(anchorProposalBeforeWrite({ ...f.record, audit: first.listingAudit }, { ...f.options, escrowAudit: first.escrowAudit }));
    expect(known.escrowAudit.transactionHash).toBe("");
    expect(f.adapters.writeContract).toHaveBeenCalledTimes(2);
    f.state[result] = false; f.state.proposalRevisions = 0n;
    await anchorProposalBeforeWrite({ ...f.record, audit: known.listingAudit }, { ...f.options, escrowAudit: known.escrowAudit });
    expect(f.adapters.writeContract).toHaveBeenCalledTimes(3);
    expect(f.adapters.writeContract.mock.calls.filter(([call]) => call.functionName === "commitOpportunity")).toHaveLength(1);
  });
});
