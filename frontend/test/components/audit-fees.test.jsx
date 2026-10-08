import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ estimate: vi.fn(), write: vi.fn(), simulate: vi.fn() }));
vi.mock("wagmi/actions", () => ({
  estimateFeesPerGas: mocks.estimate,
  writeContract: mocks.write,
  simulateContract: mocks.simulate,
  readContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));
vi.mock("../../src/lib/wagmi.js", () => ({ wagmiConfig: {} }));
import { createWagmiAuditAdapters } from "../../src/lib/auditRegistry.js";

const config = {};
const request = { chainId: 421614, account: `0x${"a".repeat(40)}`, args: [] };
const feeEstimate = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 5_000n };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  mocks.estimate.mockReset();
  mocks.write.mockReset().mockResolvedValue(`0x${"b".repeat(64)}`);
  mocks.simulate.mockReset().mockResolvedValue({});
});

it("buffers fresh fee caps for every audit write without increasing the priority fee", async () => {
  const adapter = createWagmiAuditAdapters(config);
  for (const [index, functionName] of [
    "commitOpportunity", "updateOpportunity", "withdrawOpportunity",
    "commitProposal", "updateHashes", "withdrawProposal",
  ].entries()) {
    const estimate = 211272000n + BigInt(index);
    mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: estimate, maxPriorityFeePerGas: 1000000n });
    await adapter.writeContract({ ...request, functionName });
    expect(mocks.estimate).toHaveBeenNthCalledWith(index + 1, config, { chainId: 421614, type: "eip1559" });
    expect(mocks.write).toHaveBeenNthCalledWith(index + 1, config, {
      ...request, functionName, maxFeePerGas: estimate * 2n, maxPriorityFeePerGas: 1000000n,
    });
    expect(mocks.write.mock.calls[index][1].maxFeePerGas).toBeGreaterThan(212608000n);
  }
});

it("does not ask the wallet to submit if fee estimation fails or is invalid", async () => {
  const adapter = createWagmiAuditAdapters(config);
  mocks.estimate.mockRejectedValueOnce(new Error("RPC unavailable"));
  await expect(adapter.writeContract(request)).rejects.toThrow("RPC unavailable");
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 0n, maxPriorityFeePerGas: 0n });
  await expect(adapter.writeContract(request)).rejects.toThrow("Unable to estimate network fees");
  expect(mocks.write).not.toHaveBeenCalled();
});

it("leaves wallet rejection to the user and refreshes fees on an explicit retry", async () => {
  const adapter = createWagmiAuditAdapters(config);
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 5_000n });
  mocks.write.mockRejectedValueOnce(Object.assign(new Error("User rejected"), { code: 4001 }));
  await expect(adapter.writeContract(request)).rejects.toMatchObject({ code: 4001 });
  expect(mocks.write).toHaveBeenCalledTimes(1);
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 5_000n });
  await adapter.writeContract(request);
  expect(mocks.write).toHaveBeenLastCalledWith(config, {
    ...request, maxFeePerGas: 6_000_000_000n, maxPriorityFeePerGas: 5_000n,
  });
});

// Arbitrum has no priority auction, so a zero tip is a normal estimate there -
// and MetaMask refuses to send one, with "Priority fee must be greater than 0"
// in its advanced-fee dialog. Sending the zero straight through stalled every
// audit write behind a wallet error that looked like a broken contract call.
it("never hands the wallet a zero priority fee", async () => {
  const adapter = createWagmiAuditAdapters(config);
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 606_672_000n, maxPriorityFeePerGas: 0n });
  await adapter.writeContract(request);
  const sent = mocks.write.mock.calls[0][1];
  expect(sent.maxPriorityFeePerGas).toBeGreaterThan(0n);
  // A tip above the total cap is an invalid transaction, and this chain's base
  // fee is small enough that the floor could otherwise exceed it.
  expect(sent.maxPriorityFeePerGas).toBeLessThanOrEqual(sent.maxFeePerGas);
  // Still negligible: well under a thousandth of the fee cap at this base fee.
  expect(sent.maxPriorityFeePerGas).toBeLessThan(sent.maxFeePerGas / 100n);
});

it("clamps the floor rather than exceeding a tiny fee cap", async () => {
  const adapter = createWagmiAuditAdapters(config);
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 100n, maxPriorityFeePerGas: 0n });
  await adapter.writeContract(request);
  const sent = mocks.write.mock.calls[0][1];
  expect(sent.maxPriorityFeePerGas).toBe(200n);
  expect(sent.maxFeePerGas).toBe(200n);
});

it("does not inflate a priority fee the network actually asked for", async () => {
  const adapter = createWagmiAuditAdapters(config);
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000n });
  await adapter.writeContract(request);
  expect(mocks.write.mock.calls[0][1].maxPriorityFeePerGas).toBe(1_000n);
});

it("does not open the wallet when the registry write would revert", async () => {
  const adapter = createWagmiAuditAdapters(config);
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 5_000n });
  mocks.simulate.mockRejectedValueOnce(Object.assign(new Error("execution reverted"), {
    cause: { data: { errorName: "InvalidInput" } },
  }));
  await expect(adapter.writeContract({ ...request, functionName: "commitOpportunity" }))
    .rejects.toThrow(/already on-chain|updateOpportunity/);
  expect(mocks.write).not.toHaveBeenCalled();
});

it.each(["fees", "simulation"])("starts both preparations together and waits for both when %s finishes first", async first => {
  const fees = deferred(), simulation = deferred();
  mocks.estimate.mockReturnValue(fees.promise);
  mocks.simulate.mockReturnValue(simulation.promise);
  const sent = { ...request, address: `0x${"c".repeat(40)}`, abi: [], functionName: "commitOpportunity" };
  const onWalletRequest = vi.fn();
  const pending = createWagmiAuditAdapters(config).writeContract(sent, { onWalletRequest });
  expect(mocks.estimate).toHaveBeenCalledTimes(1);
  expect(mocks.simulate).toHaveBeenCalledWith(config, sent);
  expect(mocks.write).not.toHaveBeenCalled();
  expect(onWalletRequest).not.toHaveBeenCalled();

  if (first === "fees") { fees.resolve(feeEstimate); await fees.promise; }
  else { simulation.resolve({}); await simulation.promise; }
  expect(mocks.write).not.toHaveBeenCalled();
  expect(onWalletRequest).not.toHaveBeenCalled();

  fees.resolve(feeEstimate);
  simulation.resolve({});
  await expect(pending).resolves.toBe(`0x${"b".repeat(64)}`);
  expect(mocks.write).toHaveBeenCalledExactlyOnceWith(config, {
    ...sent, maxFeePerGas: 4_000_000_000n, maxPriorityFeePerGas: 5_000n,
  });
  expect(onWalletRequest).toHaveBeenCalledExactlyOnceWith();
  expect(onWalletRequest.mock.invocationCallOrder[0]).toBeLessThan(mocks.write.mock.invocationCallOrder[0]);
  expect(mocks.write.mock.calls[0][1]).not.toHaveProperty("onWalletRequest");
});

it("a failed fee estimate cannot later open the wallet when the concurrent simulation finishes", async () => {
  const fees = deferred(), simulation = deferred();
  mocks.estimate.mockReturnValue(fees.promise);
  mocks.simulate.mockReturnValue(simulation.promise);
  const onWalletRequest = vi.fn();
  const pending = createWagmiAuditAdapters(config).writeContract(request, { onWalletRequest });
  const failure = expect(pending).rejects.toThrow("RPC unavailable");
  fees.reject(new Error("RPC unavailable"));
  await failure;
  simulation.resolve({});
  await simulation.promise;
  expect(mocks.write).not.toHaveBeenCalled();
  expect(onWalletRequest).not.toHaveBeenCalled();
});

it("preserves the decorated simulation error while the concurrent fee estimate is pending", async () => {
  const fees = deferred(), simulation = deferred();
  mocks.estimate.mockReturnValue(fees.promise);
  mocks.simulate.mockReturnValue(simulation.promise);
  const error = Object.assign(new Error("execution reverted"), { cause: { data: { errorName: "InvalidInput" } } });
  const onWalletRequest = vi.fn();
  const pending = createWagmiAuditAdapters(config).writeContract({ ...request, functionName: "commitOpportunity" }, { onWalletRequest });
  const failure = expect(pending).rejects.toMatchObject({
    cause: error, auditErrorName: "InvalidInput", auditFunctionName: "commitOpportunity",
  });
  simulation.reject(error);
  await failure;
  fees.resolve(feeEstimate);
  await fees.promise;
  expect(mocks.write).not.toHaveBeenCalled();
  expect(onWalletRequest).not.toHaveBeenCalled();
});
