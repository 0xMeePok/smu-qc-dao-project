import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn(), confirm: vi.fn() }));
vi.mock("firebase/functions", () => ({ httpsCallable: (_functions, name) => payload => mocks.call(name, payload) }));
vi.mock("../../src/lib/firebase.js", () => ({ functions: {} }));
vi.mock("../../src/lib/authFlow.js", () => ({ requireFirebase: () => {} }));
vi.mock("../../src/lib/escrow.js", async importOriginal => ({ ...await importOriginal(), confirmEscrowTransaction: (...args) => mocks.confirm(...args) }));
import { activateIndependentFunding, independentFundingConfigured, independentFundingError, independentFundingLocked, independentFundingStatus,
  writeIndependentFundingAction } from "../../src/lib/independentEscrow.js";
import { hashEscrowEvidence } from "../../src/lib/escrow.js";

const account = `0x${"a".repeat(40)}`, address = `0x${"b".repeat(40)}`, token = `0x${"c".repeat(40)}`;
const tx = `0x${"1".repeat(64)}`, evidenceHash = `0x${"2".repeat(64)}`;
const abi = [{ type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "voteCompletion", stateMutability: "nonpayable", inputs: [
    { name: "version", type: "uint256" }, { name: "evidenceHash", type: "bytes32" }, { name: "approve", type: "bool" }], outputs: [] },
  { type: "function", name: "submitEvidence", stateMutability: "nonpayable", inputs: [{ name: "evidenceHash", type: "bytes32" }], outputs: [] }];
const prepared = (functionName = "deposit", args = ["2000000"]) => ({ chainId: 421614, address, abi, functionName, args,
  tokenAddress: token, tokenDecimals: 6, tokenSymbol: "USDT", amountBaseUnits: "2000000" });
const adapters = (allowance = 0n, balance = 2000000n) => ({ writeContract: vi.fn().mockResolvedValue(tx),
  readContract: vi.fn(async ({ functionName }) => functionName === "allowance" ? allowance : balance) });
beforeEach(() => { vi.clearAllMocks(); mocks.confirm.mockResolvedValue({ transactionHash: tx, receipt: { status: "success" } }); });

describe("independent crowdfunding wallet actions", () => {
  it("approves only the exact contribution, including a zero reset for a smaller USDT allowance", async () => {
    const wallet = adapters(1000000n), prepare = vi.fn().mockResolvedValue(prepared());
    await writeIndependentFundingAction({ proposalId: "listing", action: "deposit", account, amount: "2", adapters: wallet, prepare });
    expect(prepare).toHaveBeenCalledWith({ proposalId: "listing", action: "deposit", amount: "2" });
    expect(wallet.writeContract.mock.calls.map(([request]) => [request.functionName, request.args])).toEqual([
      ["approve", [address, 0n]], ["approve", [address, 2000000n]], ["deposit", [2000000n]],
    ]);
    expect(mocks.confirm).toHaveBeenCalledTimes(3);
  });
  it("skips token approval when an adequate allowance exists and rejects insufficient balances", async () => {
    const wallet = adapters(2000000n);
    await writeIndependentFundingAction({ proposalId: "listing", action: "deposit", account, amount: "2",
      adapters: wallet, prepare: async () => prepared() });
    expect(wallet.writeContract.mock.calls.map(([request]) => request.functionName)).toEqual(["deposit"]);
    const empty = adapters(0n, 1n);
    await expect(writeIndependentFundingAction({ proposalId: "listing", action: "deposit", account, amount: "2",
      adapters: empty, prepare: async () => prepared() })).rejects.toThrow(/wallet's token balance/);
    expect(empty.writeContract).not.toHaveBeenCalled();
  });
  it("uses the verified evidence version and hash for a weighted completion vote", async () => {
    const wallet = adapters(), prepare = vi.fn().mockResolvedValue(prepared("voteCompletion", ["4", evidenceHash, true]));
    await writeIndependentFundingAction({ proposalId: "listing", action: "vote", account, evidenceHash, approve: true,
      adapters: wallet, prepare });
    expect(prepare).toHaveBeenCalledWith({ proposalId: "listing", action: "vote", evidenceHash, approve: true });
    expect(wallet.writeContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "voteCompletion", args: [4n, evidenceHash, true] }),
      expect.objectContaining({ onWalletRequest: expect.any(Function) }));
  });
  it("asks for wallet confirmation only when the adapter has finished its prechecks", async () => {
    const wallet = adapters(), updates = [];
    let openWallet, finish;
    wallet.writeContract.mockImplementation((_request, options) => new Promise(resolve => {
      openWallet = options.onWalletRequest;
      finish = resolve;
    }));
    const pending = writeIndependentFundingAction({ proposalId: "listing", action: "vote", account,
      evidenceHash, approve: true, adapters: wallet, prepare: async () => prepared("voteCompletion", ["4", evidenceHash, true]),
      onChange: update => updates.push(update) });
    expect(updates).toEqual([{ status: "preparing", action: "vote" }]);
    await vi.waitFor(() => expect(wallet.writeContract).toHaveBeenCalledOnce());
    expect(updates.every(update => update.status === "preparing")).toBe(true);
    openWallet();
    expect(updates.at(-1)).toEqual({ status: "awaiting_signature", action: "vote" });
    finish(tx);
    await pending;
    expect(updates.slice(-2).map(update => update.status)).toEqual(["pending", "confirmed"]);
  });
  it("sends the readable decline reason for the backend to hash with the independent domain", async () => {
    const reason = "The delivery scope has changed", wallet = adapters();
    const prepare = vi.fn().mockResolvedValue(prepared("submitEvidence", [evidenceHash]));
    await writeIndependentFundingAction({ proposalId: "listing", action: "decline", account, reason: `  ${reason}  `,
      adapters: wallet, prepare });
    expect(prepare).toHaveBeenCalledWith({ proposalId: "listing", action: "decline", reason });
    expect(prepare.mock.calls[0][0]).not.toHaveProperty("reasonHash");
  });
  it("binds readable delivery evidence to the same hash prepared by the backend", async () => {
    const evidence = { summary: "Working prototype delivered", url: "https://example.com/evidence" };
    const hash = hashEscrowEvidence(evidence), prepare = vi.fn().mockResolvedValue(prepared("submitEvidence", [hash]));
    await writeIndependentFundingAction({ proposalId: "listing", action: "submitEvidence", account, evidence,
      adapters: adapters(), prepare });
    expect(prepare).toHaveBeenCalledWith({ proposalId: "listing", action: "submitEvidence", evidence, evidenceHash: hash });
  });
  it("keeps a submitted hash on a confirmation outage instead of sending another wallet transaction", async () => {
    const wallet = adapters(); mocks.confirm.mockRejectedValue(Object.assign(new Error("Confirmation pending"), { transactionHash: tx }));
    await expect(writeIndependentFundingAction({ proposalId: "listing", action: "accept", account, adapters: wallet,
      prepare: async () => prepared("submitEvidence", [evidenceHash]) })).rejects.toMatchObject({ transactionHash: tx, action: "accept" });
    expect(wallet.writeContract).toHaveBeenCalledOnce();
  });
  it("preserves the activation hash if indexing fails after the factory transaction confirms", async () => {
    mocks.call.mockImplementation(async name => {
      if (name === "prepareIndependentFundingAction") return { data: prepared("submitEvidence", [evidenceHash]) };
      throw new Error("Indexing unavailable");
    });
    const wallet = adapters();
    await expect(activateIndependentFunding("listing", { account, adapters: wallet })).rejects.toMatchObject({ transactionHash: tx, action: "activate" });
    expect(mocks.call).toHaveBeenLastCalledWith("syncIndependentFunding", { proposalId: "listing", transactionHash: tx });
  });
  it("keeps activation and payment status separate from old indicative approach metadata", () => {
    expect(independentFundingConfigured({ enabled: false, factoryAddress: address })).toBe(false);
    expect(independentFundingConfigured({ enabled: true, factoryAddress: address })).toBe(true);
    expect(independentFundingConfigured({ factoryAddress: `0x${"0".repeat(40)}` })).toBe(false);
    expect(independentFundingLocked({ exists: true, summary: { totalDeposited: "0" } })).toBe(true);
    expect(independentFundingStatus({ exists: false }).label).toBe("Funding activation required");
    expect(independentFundingStatus({ exists: true, summary: { state: "Open", totalDeposited: "2000000", fundingTarget: "2000000" } }).label).toBe("Target reached");
    expect(independentFundingStatus({ state: "Released", totalDeposited: "2000000", fundingTarget: "2000000" }).label).toBe("Fully paid");
  });
  it("keeps read outages and pending wallet transactions distinct from a failed submission", () => {
    const outage = new Error("Failed to fetch https://rpc.example/private-api-key");
    expect(independentFundingError(outage, { reading: true })).toMatch(/status is temporarily unavailable/);
    const pending = independentFundingError(outage, { transactionHash: tx });
    expect(pending).toMatch(/was submitted/);
    expect(pending).toMatch(/same transaction/);
    expect(pending).not.toMatch(/Nothing was submitted|private-api-key/);
  });
});


it.each([
  { data: { errorName: "FundingTargetExceeded", args: [123n] } },
  { auditErrorName: "FundingTargetExceeded", message: "The verification transaction would revert." },
  { message: "Funding failed", cause: { message: "Adapter wrapped simulation", cause: { data: { errorName: "FundingTargetExceeded", args: [123n] } } } },
])("explains a decoded over-target deposit failure through wrapper errors", error => {
  expect(independentFundingError(error)).toBe("That contribution exceeds the funding still needed. Refresh funding status and enter the remaining amount or less.");
});

it("preserves exact backend remaining-amount errors and does not guess an unidentified receipt revert", () => {
  const backend = { code: "functions/invalid-argument", message: "Only 0.765433 USDC is still needed. Enter this amount or less." };
  expect(independentFundingError(backend)).toBe(backend.message);
  const reverted = Object.assign(new Error("The escrow transaction reverted. No change was applied by this transaction."),
    { transactionHash: tx, transactionSettled: true, outcome: "reverted" });
  expect(independentFundingError(reverted)).toMatch(/reverted/);
  expect(independentFundingError(reverted)).not.toMatch(/exceeds|remaining amount|was submitted/);
});

it("keeps transaction recovery when confirmation is pending even if a wrapped error mentions overfunding", () => {
  const error = { transactionHash: tx, cause: { data: { errorName: "FundingTargetExceeded" } } };
  expect(independentFundingError(error)).toMatch(/Retry confirmation to check the same transaction/);
});

it("reports the over-target race after approval without treating the approval as a failed pending deposit", async () => {
  const wallet = adapters();
  const failure = Object.assign(new Error("The verification transaction would revert."), {
    auditErrorName: "FundingTargetExceeded", cause: { data: { errorName: "FundingTargetExceeded", args: [1n] } },
  });
  wallet.writeContract.mockImplementation(async request => {
    if (request.functionName === "deposit") throw failure;
    return tx;
  });
  let error;
  try { await writeIndependentFundingAction({ proposalId: "listing", action: "deposit", account, amount: "2", adapters: wallet, prepare: async () => prepared() }); }
  catch (cause) { error = cause; }
  expect(error).toBe(failure);
  expect(wallet.writeContract.mock.calls.map(([request]) => request.functionName)).toEqual(["approve", "deposit"]);
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(error.transactionHash).toBeUndefined();
  expect(independentFundingError(error)).toMatch(/exceeds the funding still needed/);
});

it.each([["AmountPrecisionExceeded", /2 decimal places/], ["ContributionBelowMinimum", /at least 1/], ["ContributionLeavesDust", /leave less than 1/]])("explains the independent funding policy error %s", (name, message) => {
  expect(independentFundingError({ cause: { data: { errorName: name } } })).toMatch(message);
});
