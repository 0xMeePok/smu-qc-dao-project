import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ estimate: vi.fn(), write: vi.fn() }));
vi.mock("wagmi/actions", () => ({
  estimateFeesPerGas: mocks.estimate,
  writeContract: mocks.write,
  readContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));
vi.mock("../../src/lib/wagmi.js", () => ({ wagmiConfig: {} }));
import { createWagmiAuditAdapters } from "../../src/lib/auditRegistry.js";

const config = {};
const request = { chainId: 421614, account: `0x${"a".repeat(40)}`, args: [] };
beforeEach(() => {
  mocks.estimate.mockReset();
  mocks.write.mockReset().mockResolvedValue(`0x${"b".repeat(64)}`);
});

it("buffers fresh fee caps for every audit write without increasing the priority fee", async () => {
  const adapter = createWagmiAuditAdapters(config);
  for (const [index, functionName] of ["commitOpportunity", "commitProposal", "updateHashes"].entries()) {
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
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 100n, maxPriorityFeePerGas: 0n });
  mocks.write.mockRejectedValueOnce(Object.assign(new Error("User rejected"), { code: 4001 }));
  await expect(adapter.writeContract(request)).rejects.toMatchObject({ code: 4001 });
  expect(mocks.write).toHaveBeenCalledTimes(1);
  mocks.estimate.mockResolvedValueOnce({ maxFeePerGas: 150n, maxPriorityFeePerGas: 0n });
  await adapter.writeContract(request);
  expect(mocks.write).toHaveBeenLastCalledWith(config, { ...request, maxFeePerGas: 300n, maxPriorityFeePerGas: 0n });
});
