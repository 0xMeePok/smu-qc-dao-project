import { beforeEach, expect, it, vi } from "vitest";
import { getPendingSponsoredTransaction, sendSponsoredTransaction } from "../../src/lib/embeddedWallet.js";
import { createWalletAuditAdapters, executePreparedAudit } from "../../src/lib/auditRegistry.js";
import { createOpportunityAuditFlow } from "../../src/lib/opportunityAuditFlow.js";
import { DEFAULT_AUDIT_REGISTRY_ADDRESS } from "../../src/config/auditRegistry.js";
import { sponsoredTransaction } from "../../../firebase/functions/test/sponsoredTx.mjs";

const account = `0x${"a".repeat(40)}`, target = `0x${"b".repeat(40)}`, hash = `0x${"1".repeat(64)}`;
const request = { from: account, to: target, data: "0x1234" };
const operation = sponsoredTransaction({ hash, blockNumber: 101n, calls: [{ sender: account, to: target, input: request.data }] });
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => localStorage.clear());

it.each([hash, ""])("shows submitted progress after saving and before mining (hash=%s)", async resultHash => {
  const approval = deferred(), mining = deferred();
  const wallet = { address: account, sendSponsoredTransaction: vi.fn(() => approval.promise) };
  const publicClient = {
    getBlockNumber: vi.fn().mockResolvedValueOnce(100n).mockResolvedValue(101n),
    getLogs: vi.fn().mockResolvedValue([{ transactionHash: hash, blockNumber: 101n, logIndex: 0 }]),
    getTransaction: vi.fn().mockResolvedValue(operation.transaction),
    waitForTransactionReceipt: vi.fn(() => mining.promise),
  };
  const observed = [];
  const onSubmitted = vi.fn(details => observed.push({ details, stored: getPendingSponsoredTransaction(account), receiptReads: publicClient.waitForTransactionReceipt.mock.calls.length }));
  const pending = sendSponsoredTransaction(request, { wallet, publicClient, onSubmitted });
  await vi.waitFor(() => expect(wallet.sendSponsoredTransaction).toHaveBeenCalledOnce());
  expect(onSubmitted).not.toHaveBeenCalled();
  approval.resolve({ hash: resultHash });
  await vi.waitFor(() => expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledOnce());
  expect(onSubmitted).toHaveBeenCalledOnce();
  expect(observed).toEqual([{ details: resultHash ? { transactionHash: hash } : {}, stored: expect.objectContaining({ phase: "submitted" }), receiptReads: 0 }]);
  expect(getPendingSponsoredTransaction(account)).not.toBeNull();
  mining.resolve(operation.receipt);
  await expect(pending).resolves.toBe(hash);
  expect(wallet.sendSponsoredTransaction).toHaveBeenCalledOnce();
  expect(getPendingSponsoredTransaction(account)).toBeNull();
});

it.each([false, true])("a failing progress observer cannot change a submitted transaction (async=%s)", async asynchronous => {
  const wallet = { address: account, sendSponsoredTransaction: vi.fn().mockResolvedValue({ hash }) };
  const publicClient = { getBlockNumber: vi.fn().mockResolvedValue(100n), waitForTransactionReceipt: vi.fn().mockResolvedValue(operation.receipt) };
  const onSubmitted = vi.fn(() => {
    if (asynchronous) return Promise.reject(new Error("Observer failed"));
    throw new Error("Observer failed");
  });
  await expect(sendSponsoredTransaction(request, { wallet, publicClient, onSubmitted })).resolves.toBe(hash);
  expect(wallet.sendSponsoredTransaction).toHaveBeenCalledOnce();
  expect(onSubmitted).toHaveBeenCalledOnce();
  expect(getPendingSponsoredTransaction(account)).toBeNull();
});

it("reports restored recovery before checking its receipt and never sends again", async () => {
  localStorage.setItem(`qcdao:privy-pending:421614:${account}`, JSON.stringify({
    id: "restored", address: account, to: target, data: request.data, value: "0", chainId: 421614,
    fromBlock: "101", phase: "submitted", transactionHash: hash,
  }));
  const wallet = { address: account, sendSponsoredTransaction: vi.fn() };
  const onSubmitted = vi.fn();
  const publicClient = { waitForTransactionReceipt: vi.fn(async () => {
    expect(onSubmitted).toHaveBeenCalledExactlyOnceWith({ transactionHash: hash });
    return operation.receipt;
  }) };
  await expect(sendSponsoredTransaction(request, { wallet, publicClient, onSubmitted })).resolves.toBe(hash);
  expect(wallet.sendSponsoredTransaction).not.toHaveBeenCalled();
});

it("passes submission progress to the wallet client without adding it to contract calldata", async () => {
  const onSubmitted = vi.fn(), writeContract = vi.fn().mockResolvedValue(hash);
  const walletClient = vi.fn().mockResolvedValue({ writeContract });
  const adapters = createWalletAuditAdapters({
    walletClient, publicClient: { simulateContract: vi.fn().mockResolvedValue({}), estimateFeesPerGas: vi.fn().mockResolvedValue({ maxFeePerGas: 100n, maxPriorityFeePerGas: 1n }) },
  });
  await adapters.writeContract({ account, chainId: 421614, address: target }, { onSubmitted });
  expect(walletClient).toHaveBeenCalledExactlyOnceWith({ account, chainId: 421614, onSubmitted });
  expect(writeContract.mock.calls[0][0]).not.toHaveProperty("onSubmitted");
});

it("reports confirming before the sponsored write resolves, then keeps receipt transitions ordered", async () => {
  const mining = deferred(), changes = [];
  const adapters = {
    writeContract: vi.fn(async (_request, options) => {
      await options.onSubmitted({});
      return mining.promise;
    }),
    waitForTransactionReceipt: vi.fn().mockResolvedValue(operation.receipt), readContract: vi.fn(),
  };
  const result = executePreparedAudit({ __auditPrepared: true, functionName: "commitOpportunity", args: [] }, {
    account, address: DEFAULT_AUDIT_REGISTRY_ADDRESS, adapters, onStatus: event => changes.push(event),
  });
  await vi.waitFor(() => expect(changes.map(event => event.status)).toEqual(["queued", "confirming"]));
  expect(adapters.waitForTransactionReceipt).not.toHaveBeenCalled();
  mining.resolve(hash);
  await result;
  expect(changes.map(event => event.status)).toEqual(["queued", "confirming", "submitted", "pending", "confirmed"]);
});

it("keeps confirming progress in memory and out of persisted audit receipts", async () => {
  const mining = deferred(), changes = [], saved = [];
  const flow = createOpportunityAuditFlow({
    kind: 0, payloadFor: () => ({}), entityLabel: "opportunity",
    prepareCommit: () => ({ hashScheme: 2, entityId: hash, contentHash: hash }),
    persistAudit: async ({ audit }) => saved.push(audit),
    commitAudit: async (_prepared, { onStatus }) => {
      await onStatus({ status: "confirming" });
      await mining.promise;
      await onStatus({ status: "submitted", transactionHash: hash });
      await onStatus({ status: "pending", transactionHash: hash });
      return { transactionHash: hash, blockNumber: 101n };
    },
    verifyAudit: async () => ({ verified: true }),
  });
  const result = flow.anchor({ id: "record" }, { account, onChange: audit => changes.push(audit) });
  await vi.waitFor(() => expect(changes.at(-1)?.status).toBe("confirming"));
  expect(saved.map(audit => audit.status)).toEqual(["queued"]);
  mining.resolve();
  await result;
  expect(saved.map(audit => audit.status)).toEqual(["queued", "submitted", "pending"]);
  expect(changes.at(-1).status).toBe("confirmed");
});
