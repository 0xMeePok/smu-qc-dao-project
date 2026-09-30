import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PrivyWalletNotReadyError, waitForPrivyWallet } from "../../src/lib/privyWallet.js";

const ADDRESS = `0x${"a".repeat(40)}`;

describe("waitForPrivyWallet", () => {
  it("activates the matching wallet and resolves once wagmi is connected", async () => {
    let connected = false;
    const calls = [];

    await waitForPrivyWallet({
      address: ADDRESS.toUpperCase(),
      wallets: () => [{ address: ADDRESS }],
      connectWallet: async (wallet) => {
        calls.push(wallet.address);
        connected = true;
      },
      isConnected: () => connected,
      timeoutMs: 500,
      intervalMs: 10,
    });

    assert.deepEqual(calls, [ADDRESS]);
  });

  it("waits until the wallet appears before activating it", async () => {
    const wallets = [];
    let connected = false;
    setTimeout(() => wallets.push({ address: ADDRESS }), 30);

    await waitForPrivyWallet({
      address: ADDRESS,
      wallets: () => wallets,
      connectWallet: async () => {
        connected = true;
      },
      isConnected: () => connected,
      timeoutMs: 500,
      intervalMs: 10,
    });

    assert.equal(connected, true);
  });

  it("throws a retryable error when the connector never connects", async () => {
    await assert.rejects(
      () => waitForPrivyWallet({
        address: ADDRESS,
        wallets: () => [],
        connectWallet: async () => false,
        isConnected: () => false,
        timeoutMs: 40,
        intervalMs: 10,
      }),
      PrivyWalletNotReadyError,
    );
  });
});
