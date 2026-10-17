import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arbitrumSepolia } from "viem/chains";

const ADDRESS = `0x${"A".repeat(40)}`;
const OTHER = `0x${"b".repeat(40)}`;

const mocks = vi.hoisted(() => ({
  privy: null,
  wallets: null,
  createWallet: null,
  signMessage: null,
  sendTransaction: null,
  login: null,
  loginCallbacks: null,
}));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => mocks.privy,
  useWallets: () => mocks.wallets,
  useCreateWallet: () => ({ createWallet: mocks.createWallet }),
  useSignMessage: () => ({ signMessage: mocks.signMessage }),
  useSendTransaction: () => ({ sendTransaction: mocks.sendTransaction }),
  // Privy's login modal: `login` opens it, the callbacks report how it ended.
  useLogin: (callbacks) => {
    mocks.loginCallbacks = callbacks;
    return { login: mocks.login };
  },
}));
// Independent of whatever .env the machine running the tests has.
vi.mock("../../src/lib/privy.js", async (importOriginal) => ({
  ...await importOriginal(),
  isPrivyConfigured: true,
  privyAppId: "test-app-id",
}));

const { WalletProvider, useWallet } = await import("../../src/context/WalletContext.jsx");
const { privyConfig, chainIdOf, connectedEmbeddedWallet, linkedEmbeddedWallet } = await import("../../src/lib/privy.js");
const {
  embeddedWalletClient, getActiveEmbeddedWallet, sendSponsoredTransaction, setActiveEmbeddedWallet, sponsoredProvider,
  getPendingSponsoredTransaction, recoverPendingSponsoredTransaction, subscribePendingSponsoredTransactions, isSponsoredTransactionInFlight,
  SPONSORSHIP_UNAVAILABLE_MESSAGE, SPONSORED_PENDING_MESSAGE,
} = await import("../../src/lib/embeddedWallet.js");
const { auditErrorMessage } = await import("../../src/lib/errors.js");
const { sponsoredTransaction } = await import("../../../firebase/functions/test/sponsoredTx.mjs");

const linked = (address = ADDRESS) => ({ type: "wallet", chainType: "ethereum", walletClientType: "privy", address });
const connected = (overrides = {}) => ({
  type: "ethereum",
  walletClientType: "privy",
  address: ADDRESS,
  chainId: "eip155:421614",
  switchChain: vi.fn(async () => {}),
  getEthereumProvider: vi.fn(async () => ({ request: vi.fn() })),
  ...overrides,
});
const signedInUser = (linkedAccounts = []) => ({
  id: "did:privy:member",
  email: { address: "ada@example.org" },
  linkedAccounts: [{ type: "email", address: "ada@example.org" }, ...linkedAccounts],
});

let api;
function Probe() {
  api = useWallet();
  return null;
}
const tree = () => <WalletProvider><Probe /></WalletProvider>;

describe("Privy configuration [QCDAO-141]", () => {
  it("allows email as the only login method and no external wallet of any kind", () => {
    expect(privyConfig.loginMethods).toEqual(["email"]);
    expect(privyConfig.externalWallets.disableAllExternalWallets).toBe(true);
    expect(privyConfig.externalWallets.walletConnect.enabled).toBe(false);
    // Privy's default wallet list includes MetaMask; the app's is empty.
    expect(privyConfig.appearance.walletList).toEqual([]);
    expect(JSON.stringify(privyConfig)).not.toMatch(/metamask|coinbase|rainbow|phantom/i);
  });

  it("keeps every embedded wallet on Arbitrum Sepolia", () => {
    expect(privyConfig.defaultChain.id).toBe(arbitrumSepolia.id);
    expect(privyConfig.supportedChains.map((chain) => chain.id)).toEqual([arbitrumSepolia.id]);
  });

  it("has Privy's login modal create the wallet on a member's first sign-in", () => {
    expect(privyConfig.embeddedWallets.ethereum.createOnLogin).toBe("users-without-wallets");
  });

  it("only ever treats Privy's own embedded wallet as the member's wallet", () => {
    const user = signedInUser([{ type: "wallet", chainType: "ethereum", walletClientType: "metamask", address: OTHER }, linked()]);
    expect(linkedEmbeddedWallet(user).address).toBe(ADDRESS);
    const injected = { type: "ethereum", walletClientType: "metamask", address: OTHER };
    expect(connectedEmbeddedWallet([injected], OTHER)).toBeNull();
    expect(connectedEmbeddedWallet([injected, connected()], ADDRESS.toLowerCase()).address).toBe(ADDRESS);
  });

  it("reads CAIP-2 and numeric chain ids alike", () => {
    expect(chainIdOf({ chainId: "eip155:421614" })).toBe(421614);
    expect(chainIdOf({ chainId: 421614 })).toBe(421614);
    expect(chainIdOf({ chainId: "0x66eee" })).toBe(421614);
    expect(chainIdOf({ chainId: "solana:mainnet" })).toBeUndefined();
  });
});

describe("WalletProvider", () => {
  beforeEach(() => {
    api = null;
    mocks.privy = { ready: true, authenticated: true, user: signedInUser([linked()]), logout: vi.fn(async () => {}) };
    mocks.wallets = { ready: true, wallets: [connected()] };
    mocks.createWallet = vi.fn(async () => ({ address: ADDRESS }));
    mocks.signMessage = vi.fn(async () => ({ signature: "0xsignature" }));
    mocks.sendTransaction = vi.fn(async () => ({ hash: "" }));
    mocks.login = vi.fn();
    mocks.loginCallbacks = null;
  });

  afterEach(() => cleanup());

  it("exposes the signed-in member's email and embedded wallet", () => {
    render(tree());
    expect(api).toMatchObject({
      configured: true, ready: true, authenticated: true, email: "ada@example.org",
      address: ADDRESS, isConnected: true, chainId: 421614,
    });
  });

  it("creates the embedded wallet on a member's first sign-in", async () => {
    mocks.privy.user = signedInUser();
    mocks.wallets = { ready: true, wallets: [] };
    const view = render(tree());
    let pending;
    await act(async () => { pending = api.ensureWallet(); });
    expect(mocks.createWallet).toHaveBeenCalledOnce();

    // Privy links the new wallet and loads its signer.
    mocks.privy = { ...mocks.privy, user: signedInUser([linked()]) };
    mocks.wallets = { ready: true, wallets: [connected()] };
    view.rerender(tree());
    await expect(pending).resolves.toBe(ADDRESS);
  });

  it("reuses the existing wallet for a returning member - same email, same address", async () => {
    render(tree());
    let address;
    await act(async () => { address = await api.ensureWallet(); });
    expect(address).toBe(ADDRESS);
    expect(mocks.createWallet).not.toHaveBeenCalled();
  });

  it("carries on when another tab created the wallet first", async () => {
    mocks.privy.user = signedInUser();
    mocks.wallets = { ready: true, wallets: [] };
    mocks.createWallet.mockRejectedValueOnce(new Error("User already has an embedded wallet."));
    const view = render(tree());
    let pending;
    await act(async () => { pending = api.ensureWallet(); });
    mocks.privy = { ...mocks.privy, user: signedInUser([linked()]) };
    mocks.wallets = { ready: true, wallets: [connected()] };
    view.rerender(tree());
    await expect(pending).resolves.toBe(ADDRESS);
  });

  it("asks Privy to confirm a message before the embedded wallet signs it", async () => {
    render(tree());
    let signature;
    await act(async () => { signature = await api.signMessage("Sign in to QC DAO", ADDRESS.toLowerCase()); });
    expect(signature).toBe("0xsignature");
    expect(mocks.signMessage).toHaveBeenCalledExactlyOnceWith(
      { message: "Sign in to QC DAO" },
      { address: ADDRESS },
    );
    expect(mocks.signMessage.mock.calls[0][1]).not.toHaveProperty("uiOptions");
    await expect(api.signMessage("Sign in to QC DAO", OTHER)).rejects.toThrow(/not ready/);
  });

  it("never reports an external wallet as the member's wallet", () => {
    mocks.privy.user = signedInUser();
    mocks.wallets = { ready: true, wallets: [{ ...connected(), walletClientType: "metamask", address: OTHER }] };
    render(tree());
    expect(api.address).toBeNull();
    expect(api.isConnected).toBe(false);
  });

  it("moves an embedded wallet that is on another network back to Arbitrum Sepolia", () => {
    const wallet = connected({ chainId: "eip155:1" });
    mocks.wallets = { ready: true, wallets: [wallet] };
    render(tree());
    expect(wallet.switchChain).toHaveBeenCalledExactlyOnceWith(arbitrumSepolia.id);
  });

  it("hands the wallet to the transaction adapters only while it is signed in", () => {
    const view = render(tree());
    expect(getActiveEmbeddedWallet()).toMatchObject({ address: ADDRESS, chainId: arbitrumSepolia.id });
    mocks.privy = { ...mocks.privy, authenticated: false, user: null };
    view.rerender(tree());
    expect(getActiveEmbeddedWallet()).toBeNull();
    view.unmount();
    expect(getActiveEmbeddedWallet()).toBeNull();
  });

  it("[QCDAO-144] asks Privy to sponsor the gas of every transaction the wallet sends", async () => {
    render(tree());
    const transaction = { to: OTHER, data: "0x1234", chainId: arbitrumSepolia.id };
    await getActiveEmbeddedWallet().sendSponsoredTransaction(transaction);
    expect(mocks.sendTransaction).toHaveBeenCalledExactlyOnceWith(transaction, { address: ADDRESS, sponsor: true });
  });

  it("opens Privy's login modal once and waits for it to finish", async () => {
    mocks.privy = { ...mocks.privy, authenticated: false, user: null };
    render(tree());
    let finished = false;
    const pending = api.login();
    void pending.then(() => { finished = true; });
    expect(api.login()).toBe(pending);
    expect(mocks.login).toHaveBeenCalledOnce();

    // A mistyped code is explained inside Privy's modal, which stays open.
    await act(async () => { mocks.loginCallbacks.onError("invalid_credentials"); });
    expect(finished).toBe(false);

    await act(async () => {
      mocks.loginCallbacks.onComplete({ user: signedInUser([linked()]), isNewUser: true, wasAlreadyAuthenticated: false });
    });
    await pending;
    expect(finished).toBe(true);
  });

  it("reports a closed login modal as a cancelled sign-in", async () => {
    mocks.privy = { ...mocks.privy, authenticated: false, user: null };
    render(tree());
    const pending = api.login();
    const cancelled = expect(pending).rejects.toMatchObject({ privyErrorCode: "exited_auth_flow" });
    await act(async () => { mocks.loginCallbacks.onError("exited_auth_flow"); });
    await cancelled;
  });

  it("does not open the modal for a member Privy already has signed in", async () => {
    render(tree());
    await api.login();
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it("does not open the modal before Privy has loaded", async () => {
    mocks.privy = { ...mocks.privy, ready: false, authenticated: false, user: null };
    render(tree());
    await expect(api.login()).rejects.toThrow(/still loading/);
    expect(mocks.login).not.toHaveBeenCalled();
  });
});

describe("embeddedWalletClient", () => {
  afterEach(() => setActiveEmbeddedWallet(null));

  it("refuses to sign when no member is signed in", async () => {
    setActiveEmbeddedWallet(null);
    await expect(embeddedWalletClient({ account: ADDRESS })).rejects.toThrow(/not ready/);
  });

  it("refuses to sign for any account but the signed-in member's", async () => {
    setActiveEmbeddedWallet({ address: ADDRESS, chainId: arbitrumSepolia.id, switchChain: vi.fn(), getEthereumProvider: vi.fn() });
    await expect(embeddedWalletClient({ account: OTHER })).rejects.toThrow(/different account/);
  });

  it("switches networks silently before asking Privy for the provider", async () => {
    const wallet = {
      address: ADDRESS,
      chainId: 1,
      switchChain: vi.fn(async () => {}),
      getEthereumProvider: vi.fn(async () => ({ request: vi.fn() })),
    };
    setActiveEmbeddedWallet(wallet);
    const client = await embeddedWalletClient({ account: ADDRESS.toLowerCase(), chainId: arbitrumSepolia.id });
    expect(wallet.switchChain).toHaveBeenCalledExactlyOnceWith(arbitrumSepolia.id);
    expect(wallet.switchChain.mock.invocationCallOrder[0]).toBeLessThan(wallet.getEthereumProvider.mock.invocationCallOrder[0]);
    expect(client.chain.id).toBe(arbitrumSepolia.id);
    expect(client.account.address).toBe(ADDRESS);
  });
});

describe("[QCDAO-144] sponsored transactions", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());
  const HASH = `0x${"1".repeat(64)}`;
  const REGISTRY = `0x${"e5".repeat(20)}`;
  const request = { from: ADDRESS, to: REGISTRY, data: "0x1234", value: "0x0" };
  const wallet = (send) => ({ address: ADDRESS, sendSponsoredTransaction: vi.fn(send) });
  const built = (hash = HASH, call = { sender: ADDRESS.toLowerCase(), to: REGISTRY, input: "0x1234" }, success = true) =>
    sponsoredTransaction({ hash, calls: [{ ...call, success }] });
  const chain = ({ success = true, logs, transactions } = {}) => {
    const ours = built(HASH, undefined, success);
    return {
      getBlockNumber: vi.fn().mockResolvedValueOnce(100n).mockResolvedValue(110n),
      getLogs: vi.fn(async () => logs ?? [{ transactionHash: HASH, blockNumber: 101n, logIndex: 3 }]),
      getTransaction: vi.fn(async ({ hash }) => (transactions ?? { [HASH]: ours.transaction })[hash]),
      waitForTransactionReceipt: vi.fn(async ({ hash }) => (hash === HASH ? ours.receipt : built(hash).receipt)),
    };
  };

  it("sends without gas fields and returns the hash once the member's call has run", async () => {
    const member = wallet(async () => ({ hash: HASH })), publicClient = chain();
    await expect(sendSponsoredTransaction({ ...request, maxFeePerGas: "0x5" }, { wallet: member, publicClient })).resolves.toBe(HASH);
    expect(member.sendSponsoredTransaction).toHaveBeenCalledExactlyOnceWith({ to: REGISTRY, data: "0x1234", chainId: arbitrumSepolia.id });
    expect(publicClient.getLogs).not.toHaveBeenCalled();
  });

  it("finds the mined transaction from the EntryPoint log when Privy returns no hash yet", async () => {
    const publicClient = chain();
    await expect(sendSponsoredTransaction(request, { wallet: wallet(async () => ({ hash: "" })), publicClient })).resolves.toBe(HASH);
    expect(publicClient.getBlockNumber).toHaveBeenNthCalledWith(1, { cacheTime: 0 });
    expect(publicClient.getLogs).toHaveBeenCalledWith(expect.objectContaining({ args: { sender: ADDRESS }, fromBlock: 101n }));
    expect(publicClient.getTransaction).toHaveBeenCalledWith({ hash: HASH });
  });

  it("ignores another operation from the same wallet and uses the one that carries this call", async () => {
    const otherHash = `0x${"2".repeat(64)}`;
    const other = built(otherHash, { sender: ADDRESS.toLowerCase(), to: OTHER, input: "0xabcd" });
    const ours = built();
    const publicClient = chain({
      logs: [
        { transactionHash: otherHash, blockNumber: 101n, logIndex: 1 },
        { transactionHash: HASH, blockNumber: 101n, logIndex: 2 },
      ],
      transactions: { [otherHash]: other.transaction, [HASH]: ours.transaction },
    });
    await expect(sendSponsoredTransaction(request, { wallet: wallet(async () => ({ hash: "" })), publicClient })).resolves.toBe(HASH);
  });

  it("sends one sponsored transaction at a time for the same wallet", async () => {
    let release;
    const held = new Promise((resolve) => { release = () => resolve({ hash: HASH }); });
    const member = wallet(() => held);
    const publicClient = chain();
    const first = sendSponsoredTransaction(request, { wallet: member, publicClient });
    const second = sendSponsoredTransaction({ ...request, data: "0x99" }, { wallet: member, publicClient });
    await vi.waitFor(() => expect(member.sendSponsoredTransaction).toHaveBeenCalledOnce());
    release();
    await expect(first).resolves.toBe(HASH);
    await expect(second).resolves.toBe(HASH);
    expect(member.sendSponsoredTransaction).toHaveBeenCalledTimes(2);
  });

  it("marks the saved record as owned by the in-flight send until that send fails", async () => {
    let fail;
    const held = new Promise((_, reject) => { fail = () => reject(new Error("socket hang up")); });
    const member = wallet(() => held);
    const notified = vi.fn();
    const stop = subscribePendingSponsoredTransactions(notified);
    const sent = sendSponsoredTransaction(request, { wallet: member, publicClient: chain() }).catch((caught) => caught);
    await vi.waitFor(() => expect(member.sendSponsoredTransaction).toHaveBeenCalledOnce());
    const saved = getPendingSponsoredTransaction(ADDRESS);
    expect(saved?.id).toBeTruthy();
    expect(isSponsoredTransactionInFlight(ADDRESS, saved.id)).toBe(true);
    fail();
    expect((await sent).walletOutcome).toBe("pending");
    // The record stays for recovery, but no running action owns it any more.
    const unresolved = getPendingSponsoredTransaction(ADDRESS);
    expect(unresolved?.id).toBe(saved.id);
    expect(isSponsoredTransactionInFlight(ADDRESS, unresolved.id)).toBe(false);
    expect(notified).toHaveBeenCalled();
    stop();
  });

  it("reports a call that failed inside a mined sponsored transaction as a revert", async () => {
    const error = await sendSponsoredTransaction(request, { wallet: wallet(async () => ({ hash: HASH })), publicClient: chain({ success: false }) })
      .catch((caught) => caught);
    expect(error.walletOutcome).toBe("reverted");
    expect(error.transactionHash).toBe(HASH);
  });

  it("explains an unavailable sponsorship, and leaves a declined confirmation as a decline", async () => {
    const unavailable = await sendSponsoredTransaction(request, { wallet: wallet(async () => { throw new Error("Gas sponsorship is not enabled for this chain"); }), publicClient: chain() })
      .catch((caught) => caught);
    expect(unavailable.message).toBe(SPONSORSHIP_UNAVAILABLE_MESSAGE);
    // viem wraps a provider error; the member still reads our sentence, not viem's.
    expect(auditErrorMessage(Object.assign(new Error("Contract call failed. Details: unknown RPC error"), { cause: { cause: unavailable } })))
      .toBe(SPONSORSHIP_UNAVAILABLE_MESSAGE);
    const declined = await sendSponsoredTransaction(request, { wallet: wallet(async () => { throw Object.assign(new Error("User exited the modal"), { code: 4001 }); }), publicClient: chain() })
      .catch((caught) => caught);
    expect(declined.code).toBe(4001);
  });

  it("stops waiting without resending when a sponsored transaction is slow to confirm", async () => {
    const error = await sendSponsoredTransaction(request, { wallet: wallet(async () => ({ hash: "" })), publicClient: chain({ logs: [] }), timeoutMs: 1 })
      .catch((caught) => caught);
    expect(error.message).toBe(SPONSORED_PENDING_MESSAGE);
  });

  it("never attributes a new hashless send to an identical operation already mined at the tip", async () => {
    const oldHash = `0x${"3".repeat(64)}`;
    const old = built(oldHash);
    const current = built();
    const publicClient = chain({ logs: [
      { transactionHash: oldHash, blockNumber: 100n, logIndex: 0 },
      { transactionHash: HASH, blockNumber: 101n, logIndex: 1 },
    ], transactions: { [oldHash]: old.transaction, [HASH]: current.transaction } });
    await expect(sendSponsoredTransaction(request, { wallet: wallet(async () => ({ hash: "" })), publicClient })).resolves.toBe(HASH);
    expect(publicClient.getTransaction).not.toHaveBeenCalledWith({ hash: oldHash });
  });

  it("preserves the known hash and recovers the same operation after a receipt RPC failure without sending again", async () => {
    const member = wallet(async () => ({ hash: HASH })), publicClient = chain();
    publicClient.waitForTransactionReceipt.mockRejectedValueOnce(new Error("HTTP request failed"));
    const changed = vi.fn(), unsubscribe = subscribePendingSponsoredTransactions(changed);
    const error = await sendSponsoredTransaction(request, { wallet: member, publicClient }).catch(caught => caught);
    expect(error).toMatchObject({ walletOutcome: "pending", transactionHash: HASH });
    expect(auditErrorMessage(error)).toBe(SPONSORED_PENDING_MESSAGE);
    expect(getPendingSponsoredTransaction(ADDRESS)).toMatchObject({ transactionHash: HASH, to: REGISTRY, fromBlock: "101" });
    expect(JSON.parse(localStorage.getItem(`qcdao:privy-pending:421614:${ADDRESS.toLowerCase()}`))).toMatchObject({ transactionHash: HASH });
    await expect(sendSponsoredTransaction(request, { wallet: member, publicClient })).resolves.toBe(HASH);
    expect(member.sendSponsoredTransaction).toHaveBeenCalledOnce();
    expect(getPendingSponsoredTransaction(ADDRESS)).toBeNull();
    expect(changed).toHaveBeenCalled();
    unsubscribe();
  });

  it("blocks a different action while the hashless operation is unresolved and explicit recovery only reads", async () => {
    const member = wallet(async () => ({ hash: "" })), publicClient = chain({ logs: [] });
    const error = await sendSponsoredTransaction(request, { wallet: member, publicClient, timeoutMs: 1 }).catch(caught => caught);
    expect(error).toMatchObject({ walletOutcome: "pending", pendingSponsoredTransaction: { to: REGISTRY } });
    await expect(sendSponsoredTransaction({ ...request, data: "0xabcd" }, { wallet: member, publicClient })).rejects.toMatchObject({ walletOutcome: "pending" });
    expect(member.sendSponsoredTransaction).toHaveBeenCalledOnce();
    publicClient.getBlockNumber.mockResolvedValue(120n);
    publicClient.getLogs.mockResolvedValue([{ transactionHash: HASH, blockNumber: 112n, logIndex: 1 }]);
    await expect(recoverPendingSponsoredTransaction({ wallet: member, publicClient })).resolves.toBe(HASH);
    expect(member.sendSponsoredTransaction).toHaveBeenCalledOnce();
    expect(getPendingSponsoredTransaction(ADDRESS)).toBeNull();
  });

  it("keeps an ambiguous wallet request failure pending rather than claiming nothing was sent", async () => {
    const member = wallet(async () => { throw new Error("Failed to fetch"); });
    const error = await sendSponsoredTransaction(request, { wallet: member, publicClient: chain() }).catch(caught => caught);
    expect(error.walletOutcome).toBe("pending");
    expect(auditErrorMessage(error)).toBe(SPONSORED_PENDING_MESSAGE);
    expect(getPendingSponsoredTransaction(ADDRESS)).toMatchObject({ phase: "unresolved" });
    await expect(sendSponsoredTransaction({ ...request, data: "0x99" }, { wallet: member, publicClient: chain() })).rejects.toMatchObject({ walletOutcome: "pending" });
    expect(member.sendSponsoredTransaction).toHaveBeenCalledOnce();
  });

  it("clears a confirmed failed operation so a deliberate new send can proceed", async () => {
    const member = wallet(async () => ({ hash: HASH }));
    await expect(sendSponsoredTransaction(request, { wallet: member, publicClient: chain({ success: false }) })).rejects.toMatchObject({
      walletOutcome: "reverted", transactionHash: HASH, transactionSettled: true,
    });
    expect(getPendingSponsoredTransaction(ADDRESS)).toBeNull();
    await expect(sendSponsoredTransaction(request, { wallet: member, publicClient: chain() })).resolves.toBe(HASH);
    expect(member.sendSponsoredTransaction).toHaveBeenCalledTimes(2);
  });

  it("restores pending recovery from storage when no in-memory operation exists", async () => {
    localStorage.setItem(`qcdao:privy-pending:421614:${ADDRESS.toLowerCase()}`, JSON.stringify({
      id: "restored", address: ADDRESS, to: REGISTRY, data: "0x1234", value: "0", chainId: 421614,
      fromBlock: "101", phase: "submitted", transactionHash: HASH, createdAt: Date.now(),
    }));
    const member = wallet(async () => ({ hash: HASH }));
    await expect(recoverPendingSponsoredTransaction({ wallet: member, publicClient: chain() })).resolves.toBe(HASH);
    expect(member.sendSponsoredTransaction).not.toHaveBeenCalled();
    expect(getPendingSponsoredTransaction(ADDRESS)).toBeNull();
  });

  it("does not broadcast when pending state cannot be saved before the wallet request", async () => {
    const member = wallet(async () => ({ hash: HASH }));
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    try {
      await expect(sendSponsoredTransaction(request, { wallet: member, publicClient: chain() })).rejects.toThrow(/preserve the pending transaction/);
      expect(member.sendSponsoredTransaction).not.toHaveBeenCalled();
      expect(getPendingSponsoredTransaction(ADDRESS)).toBeNull();
    } finally { storage.mockRestore(); }
  });

  it("clears the pending guard after an explicit declined confirmation", async () => {
    const member = wallet(async () => { throw Object.assign(new Error("User rejected request"), { code: 4001 }); });
    await expect(sendSponsoredTransaction(request, { wallet: member, publicClient: chain() })).rejects.toMatchObject({ code: 4001 });
    expect(getPendingSponsoredTransaction(ADDRESS)).toBeNull();
    member.sendSponsoredTransaction.mockResolvedValue({ hash: HASH });
    await expect(sendSponsoredTransaction(request, { wallet: member, publicClient: chain() })).resolves.toBe(HASH);
    expect(member.sendSponsoredTransaction).toHaveBeenCalledTimes(2);
  });

  it("takes the browser's shared wallet lock before starting a sponsored send", async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
    const requestLock = vi.fn(async (_key, action) => action());
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: requestLock } });
    try {
      await expect(sendSponsoredTransaction(request, { wallet: wallet(async () => ({ hash: HASH })), publicClient: chain() })).resolves.toBe(HASH);
      expect(requestLock).toHaveBeenCalledWith(`qcdao:privy-pending:421614:${ADDRESS.toLowerCase()}`, expect.any(Function));
    } finally {
      if (previous) Object.defineProperty(navigator, "locks", previous); else delete navigator.locks;
    }
  });

  it("blocks a new send when a restored pending record contains malformed JSON", async () => {
    localStorage.setItem(`qcdao:privy-pending:421614:${OTHER.toLowerCase()}`, "{malformed");
    const member = { ...wallet(async () => ({ hash: HASH })), address: OTHER };
    expect(getPendingSponsoredTransaction(OTHER)).toMatchObject({ id: "unreadable", address: OTHER });
    await expect(sendSponsoredTransaction({ ...request, from: OTHER }, { wallet: member, publicClient: chain() })).rejects.toMatchObject({ walletOutcome: "pending" });
    expect(member.sendSponsoredTransaction).not.toHaveBeenCalled();
  });

  it("does not treat a failed storage read as absence of a pending operation after reload", async () => {
    const member = { ...wallet(async () => ({ hash: HASH })), address: OTHER };
    const storage = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Read unavailable"); });
    try {
      expect(getPendingSponsoredTransaction(OTHER)).toMatchObject({ id: "unreadable", address: OTHER });
      await expect(sendSponsoredTransaction({ ...request, from: OTHER }, { wallet: member, publicClient: chain() })).rejects.toMatchObject({ walletOutcome: "pending" });
      expect(member.sendSponsoredTransaction).not.toHaveBeenCalled();
    } finally { storage.mockRestore(); }
  });

  it("retains the known in-memory hash when reading pending storage fails", async () => {
    const member = wallet(async () => ({ hash: HASH })), publicClient = chain();
    publicClient.waitForTransactionReceipt.mockRejectedValueOnce(new Error("HTTP request failed"));
    await expect(sendSponsoredTransaction(request, { wallet: member, publicClient })).rejects.toMatchObject({ transactionHash: HASH });
    const storage = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Read unavailable"); });
    try {
      expect(getPendingSponsoredTransaction(ADDRESS)).toMatchObject({ transactionHash: HASH });
      await expect(recoverPendingSponsoredTransaction({ wallet: member, publicClient })).resolves.toBe(HASH);
      expect(member.sendSponsoredTransaction).toHaveBeenCalledOnce();
    } finally { storage.mockRestore(); }
  });

  it("pages a large block gap using small explicit ranges and finds the original call", async () => {
    const member = wallet(async () => ({ hash: "" })), publicClient = chain();
    publicClient.getBlockNumber.mockReset().mockResolvedValueOnce(100n).mockResolvedValue(20_000n);
    publicClient.getLogs.mockImplementation(async ({ fromBlock, toBlock }) => {
      expect(toBlock - fromBlock + 1n).toBeLessThanOrEqual(1_000n);
      return fromBlock <= 4_500n && toBlock >= 4_500n ? [{ transactionHash: HASH, blockNumber: 4_500n, logIndex: 1 }] : [];
    });
    await expect(sendSponsoredTransaction(request, { wallet: member, publicClient })).resolves.toBe(HASH);
    expect(publicClient.getLogs).toHaveBeenCalledTimes(5);
    expect(publicClient.getLogs).toHaveBeenNthCalledWith(1, expect.objectContaining({ fromBlock: 101n, toBlock: 1_100n }));
    expect(member.sendSponsoredTransaction).toHaveBeenCalledOnce();
  });

  it("bounds each recovery scan and resumes its saved cursor across checks", async () => {
    const member = wallet(async () => ({ hash: "" })), publicClient = chain();
    publicClient.getBlockNumber.mockReset().mockResolvedValueOnce(100n).mockResolvedValue(100_000n);
    publicClient.getLogs.mockResolvedValue([]);
    await expect(sendSponsoredTransaction(request, { wallet: member, publicClient })).rejects.toMatchObject({ walletOutcome: "pending" });
    expect(publicClient.getLogs).toHaveBeenCalledTimes(8);
    const saved = getPendingSponsoredTransaction(ADDRESS);
    expect(BigInt(saved.scanFromBlock)).toBeGreaterThan(7_000n);
    expect(saved.fromBlock).toBe("101");
    publicClient.getLogs.mockClear().mockImplementation(async ({ fromBlock }) => [{ transactionHash: HASH, blockNumber: fromBlock + 10n, logIndex: 1 }]);
    await expect(recoverPendingSponsoredTransaction({ wallet: member, publicClient, timeoutMs: 10_000 })).resolves.toBe(HASH);
    expect(publicClient.getLogs).toHaveBeenNthCalledWith(1, expect.objectContaining({ fromBlock: BigInt(saved.scanFromBlock) }));
    expect(member.sendSponsoredTransaction).toHaveBeenCalledOnce();
  });

  it("retains the current page after a provider failure and retries that page without resending", async () => {
    const member = wallet(async () => ({ hash: "" })), publicClient = chain();
    publicClient.getBlockNumber.mockReset().mockResolvedValueOnce(100n).mockResolvedValue(20_000n);
    publicClient.getLogs.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("Provider log range unavailable"));
    await expect(sendSponsoredTransaction(request, { wallet: member, publicClient })).rejects.toMatchObject({ walletOutcome: "pending" });
    const saved = getPendingSponsoredTransaction(ADDRESS);
    expect(saved.scanFromBlock).toBe("1099");
    publicClient.getLogs.mockClear().mockResolvedValue([{ transactionHash: HASH, blockNumber: 1_200n, logIndex: 1 }]);
    await expect(recoverPendingSponsoredTransaction({ wallet: member, publicClient })).resolves.toBe(HASH);
    expect(publicClient.getLogs).toHaveBeenNthCalledWith(1, expect.objectContaining({ fromBlock: 1_099n, toBlock: 2_098n }));
    expect(member.sendSponsoredTransaction).toHaveBeenCalledOnce();
  });

  it("does not advance a page when a matching log's transaction cannot be read", async () => {
    const member = wallet(async () => ({ hash: "" })), publicClient = chain();
    publicClient.getBlockNumber.mockReset().mockResolvedValueOnce(100n).mockResolvedValue(20_000n);
    publicClient.getLogs.mockResolvedValue([{ transactionHash: HASH, blockNumber: 500n, logIndex: 1 }]);
    publicClient.getTransaction.mockRejectedValueOnce(new Error("Transaction read unavailable"));
    await expect(sendSponsoredTransaction(request, { wallet: member, publicClient })).rejects.toMatchObject({ walletOutcome: "pending" });
    expect(getPendingSponsoredTransaction(ADDRESS).scanFromBlock).toBe("101");
    await expect(recoverPendingSponsoredTransaction({ wallet: member, publicClient })).resolves.toBe(HASH);
    expect(member.sendSponsoredTransaction).toHaveBeenCalledOnce();
  });

  it("retains a discovered hash after its receipt read fails and avoids scanning or sending again", async () => {
    const member = wallet(async () => ({ hash: "" })), publicClient = chain();
    publicClient.waitForTransactionReceipt.mockRejectedValueOnce(new Error("Receipt unavailable"));
    await expect(sendSponsoredTransaction(request, { wallet: member, publicClient })).rejects.toMatchObject({ walletOutcome: "pending", transactionHash: HASH });
    expect(getPendingSponsoredTransaction(ADDRESS)).toMatchObject({ transactionHash: HASH, scanFromBlock: "101" });
    publicClient.getLogs.mockClear();
    await expect(recoverPendingSponsoredTransaction({ wallet: member, publicClient })).resolves.toBe(HASH);
    expect(publicClient.getLogs).not.toHaveBeenCalled();
    expect(member.sendSponsoredTransaction).toHaveBeenCalledOnce();
  });

  it("keeps page progress in memory if updating storage temporarily fails", async () => {
    const member = wallet(async () => ({ hash: "" })), publicClient = chain();
    publicClient.getBlockNumber.mockReset().mockResolvedValueOnce(100n).mockResolvedValue(100_000n);
    publicClient.getLogs.mockResolvedValue([]);
    const originalSet = Storage.prototype.setItem;
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (BigInt(JSON.parse(value).scanFromBlock ?? "0") > 101n) throw new Error("Storage write unavailable");
      return originalSet.call(this, key, value);
    });
    try {
      await expect(sendSponsoredTransaction(request, { wallet: member, publicClient })).rejects.toMatchObject({ walletOutcome: "pending" });
      expect(BigInt(getPendingSponsoredTransaction(ADDRESS).scanFromBlock)).toBeGreaterThan(7_000n);
    } finally { storage.mockRestore(); }
  });

  it("routes only transaction sending through sponsorship; reads stay on Privy's provider", async () => {
    const provider = { request: vi.fn(async () => "0x66eee") };
    const routed = sponsoredProvider(provider, { wallet: wallet(async () => ({ hash: HASH })), publicClient: chain() });
    await expect(routed.request({ method: "eth_chainId" })).resolves.toBe("0x66eee");
    await expect(routed.request({ method: "eth_sendTransaction", params: [request] })).resolves.toBe(HASH);
    expect(provider.request).toHaveBeenCalledOnce();
  });
});
