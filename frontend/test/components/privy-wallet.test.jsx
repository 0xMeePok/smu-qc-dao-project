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
  login: null,
  loginCallbacks: null,
}));

vi.mock("@privy-io/react-auth", () => ({
  usePrivy: () => mocks.privy,
  useWallets: () => mocks.wallets,
  useCreateWallet: () => ({ createWallet: mocks.createWallet }),
  useSignMessage: () => ({ signMessage: mocks.signMessage }),
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
const { embeddedWalletClient, getActiveEmbeddedWallet, setActiveEmbeddedWallet } = await import("../../src/lib/embeddedWallet.js");

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

  it("signs the sign-in challenge with the embedded wallet, without a second prompt", async () => {
    render(tree());
    let signature;
    await act(async () => { signature = await api.signMessage("Sign in to QC DAO", ADDRESS.toLowerCase()); });
    expect(signature).toBe("0xsignature");
    expect(mocks.signMessage).toHaveBeenCalledExactlyOnceWith(
      { message: "Sign in to QC DAO" },
      { address: ADDRESS, uiOptions: { showWalletUIs: false } },
    );
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
