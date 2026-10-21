import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress } from "viem";
import { AUDIT_REGISTRY_CONFIG } from "../../src/config/auditRegistry.js";
import { WALLET_TOKENS, confirmWalletTokenTransfer, createFaucetClaim, readWalletBalances, sendWalletTokens, validateTokenTransfer } from "../../src/lib/walletTokens.js";

const address = `0x${"ab".repeat(20)}`;
const recipient = `0x${"cd".repeat(20)}`;
const transactionHash = `0x${"12".repeat(32)}`;
const token = WALLET_TOKENS.find(item => item.symbol === "USDC");
const input = { token: "USDC", amount: 1_234_567n, recipient, address };

function transferLog({ from = address, to = recipient, amount = input.amount, contract = token.address } = {}) {
  return { address: contract,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [amount]) };
}

function fixture({ balance = 10_000_000n, simulation = { result: true }, receipt, writeError, waitError } = {}) {
  const reads = [], simulations = [], walletLookups = [], writes = [], waits = [];
  const publicClient = {
    readContract: async request => { reads.push(request); return balance; },
    simulateContract: async request => { simulations.push(request); return simulation; },
    waitForTransactionReceipt: async request => {
      waits.push(request);
      if (waitError) throw waitError;
      return receipt ?? { status: "success", transactionHash, logs: [transferLog()] };
    },
  };
  const walletClient = async options => {
    walletLookups.push(options);
    return { writeContract: async request => { writes.push(request); if (writeError) throw writeError; return transactionHash; } };
  };
  return { publicClient, walletClient, reads, simulations, walletLookups, writes, waits };
}

describe("wallet token balances and exact transfer inputs", () => {
  it("uses the funding manifest and reads each supported token's balance", async () => {
    assert.deepEqual(WALLET_TOKENS, AUDIT_REGISTRY_CONFIG.escrow.tokens.map(item => ({ ...item, address: getAddress(item.address) })));
    const f = fixture();
    assert.deepEqual(await readWalletBalances(address, f), { XSGD: 10_000_000n, USDT: 10_000_000n, USDC: 10_000_000n });
    assert.deepEqual(f.reads.map(read => read.address), WALLET_TOKENS.map(item => item.address));
    assert.ok(f.reads.every(read => read.functionName === "balanceOf" && read.args[0] === getAddress(address)));
  });

  it("does not present an unavailable balance as zero", async () => {
    const f = fixture({ balance: undefined });
    f.publicClient.readContract = async () => { throw new Error("RPC unavailable"); };
    await assert.rejects(readWalletBalances(address, f), /RPC unavailable/);
  });

  it("preserves all six decimals without floating point conversion", () => {
    assert.deepEqual(validateTokenTransfer({ ...input, amount: "1.234567", balance: 1_234_567n }), {
      token, amount: 1_234_567n, recipient: getAddress(recipient),
    });
    assert.equal(validateTokenTransfer({ ...input, amount: "9007199254.740993", balance: 9_007_199_254_740_993n }).amount, 9_007_199_254_740_993n);
  });

  it("rejects zero, overprecision, exponent notation, negative and overbalance amounts", () => {
    for (const amount of ["0", "0.000000", "0.0000001", "1e3", "-1", "NaN", "1,000", "", "2.000001"]) {
      assert.throws(() => validateTokenTransfer({ ...input, amount, balance: 2_000_000n }));
    }
    assert.throws(() => validateTokenTransfer({ ...input, amount: "1", balance: undefined }), /Refresh your wallet balance/);
    assert.throws(() => validateTokenTransfer({ ...input, amount: "1" + "0".repeat(80), balance: 1n << 300n }), /supported range/);
  });

  it("rejects invalid, zero or self recipients and unsupported contracts", () => {
    for (const to of [address, getAddress(address), "not-an-address", `0x${"0".repeat(40)}`]) {
      assert.throws(() => validateTokenTransfer({ ...input, amount: "1", recipient: to, balance: 2_000_000n }));
    }
    assert.throws(() => validateTokenTransfer({ ...input, token: "ETH", amount: "1", balance: 2_000_000n }), /supported test token/);
    assert.throws(() => validateTokenTransfer({ ...input, token: { symbol: "USDC", address: recipient }, amount: "1", balance: 2_000_000n }), /supported test token/);
  });
});

describe("one sponsored token transfer and read-only receipt recovery", () => {
  it("rechecks balance, simulates the exact call and confirms matching Transfer evidence", async () => {
    const f = fixture(), submitted = [];
    const result = await sendWalletTokens({ ...input, onSubmitted: event => submitted.push(event) }, f);
    assert.equal(result.transactionHash, transactionHash);
    assert.equal(result.amount, input.amount);
    assert.equal(f.reads.length, 1);
    assert.equal(f.simulations.length, 1);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.simulations[0].args, [getAddress(recipient), input.amount]);
    assert.deepEqual(f.writes[0].args, f.simulations[0].args);
    assert.equal(f.writes[0].address, token.address);
    assert.equal(f.walletLookups[0].account, getAddress(address));
    assert.equal(f.walletLookups[0].chainId, 421614);
    assert.deepEqual(submitted, [{ transactionHash }]);
    assert.equal(f.waits[0].confirmations, 2);
    assert.equal(f.waits[0].timeout, 120_000);
  });

  it("never opens the wallet if the fresh balance fell or simulation returns false", async () => {
    for (const options of [{ balance: 1n }, { simulation: { result: false } }]) {
      const f = fixture(options);
      await assert.rejects(sendWalletTokens(input, f));
      assert.equal(f.walletLookups.length, 0);
      assert.equal(f.writes.length, 0);
    }
  });

  it("does not retry a declined signing prompt", async () => {
    const rejection = Object.assign(new Error("User rejected the request"), { code: 4001 });
    const f = fixture({ writeError: rejection });
    await assert.rejects(sendWalletTokens(input, f), error => error === rejection);
    assert.equal(f.writes.length, 1);
    assert.equal(f.waits.length, 0);
  });

  it("rejects a second concurrent send instead of queueing another transfer", async () => {
    const f = fixture();
    let finishRead;
    f.publicClient.readContract = () => new Promise(resolve => { finishRead = resolve; });
    const first = sendWalletTokens(input, f);
    await assert.rejects(sendWalletTokens(input, f), /already in progress/);
    finishRead(10_000_000n);
    await first;
    assert.equal(f.writes.length, 1);
  });

  it("preserves unresolved sponsored-operation details through viem wrapping", async () => {
    const pending = Object.assign(new Error("Waiting for sponsorship"), { walletOutcome: "pending", pendingSponsoredTransaction: { id: "pending-156" } });
    const f = fixture({ writeError: new Error("viem wrapped RPC failure", { cause: pending }) });
    await assert.rejects(sendWalletTokens(input, f), error => error.walletOutcome === "pending" && error.pendingSponsoredTransaction.id === "pending-156");
    assert.equal(f.writes.length, 1);
  });

  it("retains the known hash after a timeout and recovers by polling without sending", async () => {
    const f = fixture({ waitError: new Error("Receipt timed out") });
    await assert.rejects(sendWalletTokens(input, f), error => error.walletOutcome === "pending" && error.transactionHash === transactionHash);
    assert.equal(f.writes.length, 1);
    assert.equal(f.waits.length, 1);
    const recovery = fixture();
    await confirmWalletTokenTransfer({ ...input, transactionHash }, recovery);
    assert.equal(recovery.reads.length, 0);
    assert.equal(recovery.walletLookups.length, 0);
    assert.equal(recovery.writes.length, 0);
    assert.equal(recovery.waits.length, 1);
  });

  it("rejects reverted, substituted or eventless receipts", async () => {
    for (const receipt of [
      { status: "reverted", logs: [] }, { status: "success", logs: [] },
      { status: "success", logs: [transferLog({ to: address })] },
      { status: "success", logs: [transferLog({ amount: input.amount + 1n })] },
      { status: "success", logs: [transferLog({ contract: recipient })] },
    ]) {
      const f = fixture({ receipt });
      await assert.rejects(sendWalletTokens(input, f), error => error.terminal === true && error.transactionHash === transactionHash);
      assert.equal(f.writes.length, 1);
    }
  });

  it("does not treat a successful cancellation replacement as a successful transfer", async () => {
    const f = fixture();
    f.publicClient.waitForTransactionReceipt = async request => {
      request.onReplaced({ reason: "cancelled", transaction: { hash: transactionHash } });
      return { status: "success", transactionHash, logs: [] };
    };
    await assert.rejects(sendWalletTokens(input, f), error => error.terminal && /cancelled/.test(error.message));
    assert.equal(f.writes.length, 1);
  });
});

it("builds exactly the faucet's chain-bound, checksummed EIP-191 mint message", () => {
  const claim = createFaucetClaim({ token: "USDC", address, issuedAt: 1_792_545_600 });
  assert.deepEqual(claim, { token: "USDC", recipient: getAddress(address), issuedAt: 1_792_545_600,
    message: `TAP Faucet Mint\nToken: USDC\nRecipient: ${getAddress(address)}\nChain ID: 421614\nIssued At: 1792545600` });
  assert.throws(() => createFaucetClaim({ token: "ETH", address, issuedAt: 1 }), /supported test token/);
  assert.throws(() => createFaucetClaim({ token, address, issuedAt: 1.5 }), /timestamp/);
});
