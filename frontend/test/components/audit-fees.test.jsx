import { beforeEach, expect, it, vi } from "vitest";
import { createAuditAdapters } from "../../src/lib/auditRegistry.js";

const mocks = vi.hoisted(() => ({ estimate: vi.fn(), write: vi.fn(), simulate: vi.fn() }));
const request = { chainId: 421614, account: `0x${"a".repeat(40)}`, args: [] };

function adapter() {
  return createAuditAdapters({
    client: {
      estimateFeesPerGas: mocks.estimate,
      simulateContract: mocks.simulate,
      readContract: vi.fn(),
      waitForTransactionReceipt: vi.fn(),
      getBlock: vi.fn(),
      getTransaction: vi.fn(),
    },
    walletClient: { writeContract: mocks.write },
  });
}

beforeEach(() => {
  mocks.estimate.mockReset();
  mocks.write.mockReset().mockResolvedValue(`0x${"b".repeat(64)}`);
  mocks.simulate.mockReset().mockResolvedValue({});
});

it("buffers fresh fee caps for every audit write without increasing the priority fee", async () => {
  const writer = adapter();
  for (const [index, functionName] of [
    "commitOpportunity", "updateOpportunity", "withdrawOpportunity",
    "commitProposal", "updateHashes", "withdrawProposal",
  ].entries()) {
    const estimate = 211272000n + BigInt(index);
    mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: estimate, maxPriorityFeePerGas: 1000000n });
    await writer.writeContract({ ...request, functionName });
    expect(mocks.estimate).toHaveBeenNthCalledWith(index + 1, { type: "eip1559" });
    expect(mocks.write).toHaveBeenNthCalledWith(index + 1, expect.objectContaining({
      ...request, functionName, maxFeePerGas: estimate * 2n, maxPriorityFeePerGas: 1000000n,
    }));
    expect(mocks.write.mock.calls[index][0].maxFeePerGas).toBeGreaterThan(212608000n);
  }
});

it("does not ask the wallet to submit if fee estimation fails or is invalid", async () => {
  const writer = adapter();
  mocks.estimate.mockRejectedValueOnce(new Error("RPC unavailable"));
  await expect(writer.writeContract(request)).rejects.toThrow("RPC unavailable");
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 0n, maxPriorityFeePerGas: 0n });
  await expect(writer.writeContract(request)).rejects.toThrow("Unable to estimate network fees");
  expect(mocks.write).not.toHaveBeenCalled();
});

it("leaves wallet rejection to the user and refreshes fees on an explicit retry", async () => {
  const writer = adapter();
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 5_000n });
  mocks.write.mockRejectedValueOnce(Object.assign(new Error("User rejected"), { code: 4001 }));
  await expect(writer.writeContract(request)).rejects.toMatchObject({ code: 4001 });
  expect(mocks.write).toHaveBeenCalledTimes(1);
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 5_000n });
  await writer.writeContract(request);
  expect(mocks.write).toHaveBeenLastCalledWith(expect.objectContaining({
    ...request, maxFeePerGas: 6_000_000_000n, maxPriorityFeePerGas: 5_000n,
  }));
});

it("never hands the wallet a zero priority fee", async () => {
  const writer = adapter();
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 606_672_000n, maxPriorityFeePerGas: 0n });
  await writer.writeContract(request);
  const sent = mocks.write.mock.calls[0][0];
  expect(sent.maxPriorityFeePerGas).toBeGreaterThan(0n);
  expect(sent.maxPriorityFeePerGas).toBeLessThanOrEqual(sent.maxFeePerGas);
  expect(sent.maxPriorityFeePerGas).toBeLessThan(sent.maxFeePerGas / 100n);
});

it("clamps the floor rather than exceeding a tiny fee cap", async () => {
  const writer = adapter();
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 100n, maxPriorityFeePerGas: 0n });
  await writer.writeContract(request);
  const sent = mocks.write.mock.calls[0][0];
  expect(sent.maxPriorityFeePerGas).toBe(200n);
  expect(sent.maxFeePerGas).toBe(200n);
});

it("does not inflate a priority fee the network actually asked for", async () => {
  const writer = adapter();
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000n });
  await writer.writeContract(request);
  expect(mocks.write.mock.calls[0][0].maxPriorityFeePerGas).toBe(1_000n);
});

it("does not open the wallet when the registry write would revert", async () => {
  const writer = adapter();
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 5_000n });
  mocks.simulate.mockRejectedValueOnce(Object.assign(new Error("execution reverted"), {
    cause: { data: { errorName: "InvalidInput" } },
  }));
  await expect(writer.writeContract({ ...request, functionName: "commitOpportunity" }))
    .rejects.toThrow(/already on-chain|updateOpportunity/);
  expect(mocks.write).not.toHaveBeenCalled();
});
