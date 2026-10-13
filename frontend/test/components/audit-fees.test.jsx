import { beforeEach, expect, it, vi } from "vitest";
import { arbitrumSepolia } from "viem/chains";
import { createWalletAuditAdapters } from "../../src/lib/auditRegistry.js";

const mocks = vi.hoisted(() => ({ estimate: vi.fn(), write: vi.fn(), simulate: vi.fn(), wallet: vi.fn() }));

const request = { chainId: 421614, account: `0x${"a".repeat(40)}`, args: [] };
// What reaches the clients: both are bound to Arbitrum Sepolia, so the chain
// travels as the wallet client's `chain` rather than as a request field.
const { chainId: _chainId, ...call } = request;
const feeEstimate = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 5_000n };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const adapters = () => createWalletAuditAdapters({
  publicClient: { estimateFeesPerGas: mocks.estimate, simulateContract: mocks.simulate },
  walletClient: mocks.wallet,
});
beforeEach(() => {
  mocks.estimate.mockReset();
  mocks.write.mockReset().mockResolvedValue(`0x${"b".repeat(64)}`);
  mocks.simulate.mockReset().mockResolvedValue({});
  mocks.wallet.mockReset().mockResolvedValue({ writeContract: mocks.write });
});

it("buffers fresh fee caps for every audit write without increasing the priority fee", async () => {
  const adapter = adapters();
  for (const [index, functionName] of [
    "commitOpportunity", "updateOpportunity", "withdrawOpportunity",
    "commitProposal", "updateHashes", "withdrawProposal",
  ].entries()) {
    const estimate = 211272000n + BigInt(index);
    mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: estimate, maxPriorityFeePerGas: 1000000n });
    await adapter.writeContract({ ...request, functionName });
    expect(mocks.estimate).toHaveBeenNthCalledWith(index + 1, { type: "eip1559" });
    expect(mocks.write).toHaveBeenNthCalledWith(index + 1, {
      ...call, functionName, maxFeePerGas: estimate * 2n, maxPriorityFeePerGas: 1000000n, chain: arbitrumSepolia,
    });
    expect(mocks.write.mock.calls[index][0].maxFeePerGas).toBeGreaterThan(212608000n);
  }
});

it("signs only with the signed-in member's embedded wallet, on Arbitrum Sepolia", async () => {
  mocks.estimate.mockResolvedValue(feeEstimate);
  await adapters().writeContract({ ...request, functionName: "commitOpportunity" });
  expect(mocks.wallet).toHaveBeenCalledExactlyOnceWith({ account: request.account, chainId: 421614 });
  await expect(adapters().writeContract({ ...request, chainId: 1, functionName: "commitOpportunity" }))
    .rejects.toThrow(/Arbitrum Sepolia only/);
  expect(mocks.write).toHaveBeenCalledTimes(1);
});

it("does not ask the wallet to submit if fee estimation fails or is invalid", async () => {
  const adapter = adapters();
  mocks.estimate.mockRejectedValueOnce(new Error("RPC unavailable"));
  await expect(adapter.writeContract(request)).rejects.toThrow("RPC unavailable");
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 0n, maxPriorityFeePerGas: 0n });
  await expect(adapter.writeContract(request)).rejects.toThrow("Unable to estimate network fees");
  expect(mocks.write).not.toHaveBeenCalled();
});

it("does not open the wallet when the embedded wallet is unavailable", async () => {
  mocks.estimate.mockResolvedValueOnce(feeEstimate);
  const unavailable = Object.assign(new Error("Your QC DAO wallet is not ready."), { name: "WalletUnavailableError" });
  mocks.wallet.mockRejectedValueOnce(unavailable);
  const onWalletRequest = vi.fn();
  await expect(adapters().writeContract(request, { onWalletRequest })).rejects.toBe(unavailable);
  expect(mocks.write).not.toHaveBeenCalled();
  expect(onWalletRequest).not.toHaveBeenCalled();
});

it("leaves wallet rejection to the user and refreshes fees on an explicit retry", async () => {
  const adapter = adapters();
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 5_000n });
  mocks.write.mockRejectedValueOnce(Object.assign(new Error("User rejected"), { code: 4001 }));
  await expect(adapter.writeContract(request)).rejects.toMatchObject({ code: 4001 });
  expect(mocks.write).toHaveBeenCalledTimes(1);
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 5_000n });
  await adapter.writeContract(request);
  expect(mocks.write).toHaveBeenLastCalledWith({
    ...call, maxFeePerGas: 6_000_000_000n, maxPriorityFeePerGas: 5_000n, chain: arbitrumSepolia,
  });
});

// Arbitrum has no priority auction, so a zero tip is a normal estimate there -
// and wallets refuse to send one ("Priority fee must be greater than 0").
// Sending the zero straight through stalled every audit write behind a wallet
// error that looked like a broken contract call.
it("never hands the wallet a zero priority fee", async () => {
  const adapter = adapters();
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 606_672_000n, maxPriorityFeePerGas: 0n });
  await adapter.writeContract(request);
  const sent = mocks.write.mock.calls[0][0];
  expect(sent.maxPriorityFeePerGas).toBeGreaterThan(0n);
  // A tip above the total cap is an invalid transaction, and this chain's base
  // fee is small enough that the floor could otherwise exceed it.
  expect(sent.maxPriorityFeePerGas).toBeLessThanOrEqual(sent.maxFeePerGas);
  // Still negligible: well under a thousandth of the fee cap at this base fee.
  expect(sent.maxPriorityFeePerGas).toBeLessThan(sent.maxFeePerGas / 100n);
});

it("clamps the floor rather than exceeding a tiny fee cap", async () => {
  const adapter = adapters();
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 100n, maxPriorityFeePerGas: 0n });
  await adapter.writeContract(request);
  const sent = mocks.write.mock.calls[0][0];
  expect(sent.maxPriorityFeePerGas).toBe(200n);
  expect(sent.maxFeePerGas).toBe(200n);
});

it("does not inflate a priority fee the network actually asked for", async () => {
  const adapter = adapters();
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000n });
  await adapter.writeContract(request);
  expect(mocks.write.mock.calls[0][0].maxPriorityFeePerGas).toBe(1_000n);
});

it("does not open the wallet when the registry write would revert", async () => {
  const adapter = adapters();
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
  const { chainId: _sentChain, ...sentCall } = sent;
  const onWalletRequest = vi.fn();
  const pending = adapters().writeContract(sent, { onWalletRequest });
  expect(mocks.estimate).toHaveBeenCalledTimes(1);
  expect(mocks.simulate).toHaveBeenCalledWith({
    address: sent.address, abi: sent.abi, functionName: sent.functionName, args: sent.args, account: sent.account,
  });
  expect(mocks.write).not.toHaveBeenCalled();
  expect(onWalletRequest).not.toHaveBeenCalled();

  if (first === "fees") { fees.resolve(feeEstimate); await fees.promise; }
  else { simulation.resolve({}); await simulation.promise; }
  expect(mocks.write).not.toHaveBeenCalled();
  expect(onWalletRequest).not.toHaveBeenCalled();

  fees.resolve(feeEstimate);
  simulation.resolve({});
  await expect(pending).resolves.toBe(`0x${"b".repeat(64)}`);
  expect(mocks.write).toHaveBeenCalledExactlyOnceWith({
    ...sentCall, maxFeePerGas: 4_000_000_000n, maxPriorityFeePerGas: 5_000n, chain: arbitrumSepolia,
  });
  expect(onWalletRequest).toHaveBeenCalledExactlyOnceWith();
  expect(onWalletRequest.mock.invocationCallOrder[0]).toBeLessThan(mocks.write.mock.invocationCallOrder[0]);
  expect(mocks.write.mock.calls[0][0]).not.toHaveProperty("onWalletRequest");
});

it("a failed fee estimate cannot later open the wallet when the concurrent simulation finishes", async () => {
  const fees = deferred(), simulation = deferred();
  mocks.estimate.mockReturnValue(fees.promise);
  mocks.simulate.mockReturnValue(simulation.promise);
  const onWalletRequest = vi.fn();
  const pending = adapters().writeContract(request, { onWalletRequest });
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
  const pending = adapters().writeContract({ ...request, functionName: "commitOpportunity" }, { onWalletRequest });
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
