import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { arbitrumSepolia } from "viem/chains";
import { embeddedWalletClient, getPendingSponsoredTransaction, setActiveEmbeddedWallet } from "../../src/lib/embeddedWallet.js";
import { sponsoredTransaction } from "../../../firebase/functions/test/sponsoredTx.mjs";
import { auditErrorMessage, walletOutcomeError } from "../../src/lib/errors.js";

const rpc = vi.hoisted(() => ({ getBlockNumber: vi.fn(), waitForTransactionReceipt: vi.fn() }));
vi.mock("../../src/lib/rpc.js", () => ({ browserPublicClient: rpc }));

const ADDRESS = `0x${"a".repeat(40)}`;
const OTHER = `0x${"b".repeat(40)}`;
const HASH = `0x${"1".repeat(64)}`;
const request = { method: "eth_sendTransaction", params: [{ from: ADDRESS, to: OTHER, data: "0x1234" }] };
const member = () => ({
  address: ADDRESS, chainId: arbitrumSepolia.id,
  switchChain: vi.fn(), getEthereumProvider: vi.fn(async () => ({ request: vi.fn() })),
  sendSponsoredTransaction: vi.fn(async () => ({ hash: HASH })),
});

beforeEach(() => {
  localStorage.clear();
  rpc.getBlockNumber.mockReset().mockResolvedValue(100n);
  rpc.waitForTransactionReceipt.mockReset().mockResolvedValue(sponsoredTransaction({
    hash: HASH, calls: [{ sender: ADDRESS, to: OTHER, input: "0x1234", success: true }],
  }).receipt);
});
afterEach(() => { setActiveEmbeddedWallet(null); localStorage.clear(); });

it.each([null, { address: OTHER }])("refuses a prepared client's send after the active wallet changes to %j", async next => {
  const wallet = member();
  setActiveEmbeddedWallet(wallet);
  const client = await embeddedWalletClient({ account: ADDRESS });
  setActiveEmbeddedWallet(next);
  await expect(client.request(request)).rejects.toThrow(/not ready/);
  expect(wallet.sendSponsoredTransaction).not.toHaveBeenCalled();
  expect(rpc.getBlockNumber).not.toHaveBeenCalled();
  expect(getPendingSponsoredTransaction(ADDRESS)).toBeNull();
});

it("rechecks the live wallet after an asynchronous pre-broadcast read", async () => {
  const wallet = member();
  setActiveEmbeddedWallet(wallet);
  const client = await embeddedWalletClient({ account: ADDRESS });
  rpc.getBlockNumber.mockImplementation(async () => {
    setActiveEmbeddedWallet(null);
    return 100n;
  });
  await expect(client.request(request)).rejects.toThrow(/not ready/);
  expect(wallet.sendSponsoredTransaction).not.toHaveBeenCalled();
  expect(getPendingSponsoredTransaction(ADDRESS)).toBeNull();
});

it("keeps a valid prepared client when React republishes the same embedded account", async () => {
  const wallet = member();
  setActiveEmbeddedWallet(wallet);
  const client = await embeddedWalletClient({ account: ADDRESS });
  setActiveEmbeddedWallet({ ...wallet });
  await expect(client.request(request)).resolves.toBe(HASH);
  expect(wallet.sendSponsoredTransaction).toHaveBeenCalledOnce();
});

it("recovers a broadcast operation after sign-out without signing again", async () => {
  const wallet = member();
  setActiveEmbeddedWallet(wallet);
  const client = await embeddedWalletClient({ account: ADDRESS });
  rpc.waitForTransactionReceipt.mockRejectedValueOnce(new Error("Connection lost after broadcast"));
  const error = await client.request(request, { retryCount: 0 }).catch(error => error);
  expect(walletOutcomeError(error)?.walletOutcome).toBe("pending");
  expect(getPendingSponsoredTransaction(ADDRESS)?.transactionHash).toBe(HASH);
  setActiveEmbeddedWallet(null);
  await expect(client.request(request)).resolves.toBe(HASH);
  expect(wallet.sendSponsoredTransaction).toHaveBeenCalledOnce();
  expect(getPendingSponsoredTransaction(ADDRESS)).toBeNull();
});

it("never automatically reopens a declined Privy prompt through viem's transport", async () => {
  const wallet = member();
  wallet.sendSponsoredTransaction.mockRejectedValue({ data: { originalError: { code: 4001 } } });
  setActiveEmbeddedWallet(wallet);
  const client = await embeddedWalletClient({ account: ADDRESS });
  const error = await client.request(request).catch(error => error);
  expect(auditErrorMessage(error)).toMatch(/declined/);
  expect(wallet.sendSponsoredTransaction).toHaveBeenCalledOnce();
  expect(getPendingSponsoredTransaction(ADDRESS)).toBeNull();
  wallet.sendSponsoredTransaction.mockResolvedValue({ hash: HASH });
  await expect(client.request(request)).resolves.toBe(HASH);
  expect(wallet.sendSponsoredTransaction).toHaveBeenCalledTimes(2);
});

it("refuses a queued send when the member signs out while another transaction is mining", async () => {
  const wallet = member();
  setActiveEmbeddedWallet(wallet);
  const client = await embeddedWalletClient({ account: ADDRESS });
  const receipt = await rpc.waitForTransactionReceipt();
  let release;
  rpc.waitForTransactionReceipt.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = client.request(request);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const second = client.request({ ...request, params: [{ ...request.params[0], data: "0xabcd" }] }).catch(error => error);
  setActiveEmbeddedWallet(null);
  release(receipt);
  await expect(first).resolves.toBe(HASH);
  expect((await second).message).toMatch(/not ready/);
  expect(wallet.sendSponsoredTransaction).toHaveBeenCalledOnce();
  expect(getPendingSponsoredTransaction(ADDRESS)).toBeNull();
});

it("allows an explicit retry after an automatic network switch fails", async () => {
  const wallet = { ...member(), chainId: 1 };
  wallet.switchChain.mockRejectedValueOnce(new Error("Network switch unavailable"));
  setActiveEmbeddedWallet(wallet);
  await expect(embeddedWalletClient({ account: ADDRESS })).rejects.toThrow("Network switch unavailable");
  expect(wallet.getEthereumProvider).not.toHaveBeenCalled();
  const client = await embeddedWalletClient({ account: ADDRESS });
  expect(client.chain.id).toBe(arbitrumSepolia.id);
  expect(wallet.switchChain).toHaveBeenCalledTimes(2);
  expect(wallet.getEthereumProvider).toHaveBeenCalledOnce();
});
