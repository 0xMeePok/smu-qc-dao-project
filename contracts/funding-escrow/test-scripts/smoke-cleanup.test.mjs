import assert from "node:assert/strict";
import { test } from "node:test";
import { Transaction, Wallet, parseEther } from "ethers";
import { BUSINESS_STEPS, GAS_RETURN_STEP, assertCleanupJournal, gasReturnPlan, returnUnusedGas } from "../scripts/smoke-cleanup.js";

const hash = index => `0x${index.toString(16).padStart(64, "0")}`;
function fixture() {
  const wallet = Wallet.createRandom(), owner = Wallet.createRandom().address;
  const config = { address: Wallet.createRandom().address, escrow: { factoryAddress: Wallet.createRandom().address } };
  const token = Wallet.createRandom().address;
  const report = { status: "failed", failedStep: GAS_RETURN_STEP, chainId: 421614, registry: config.address,
    factory: config.escrow.factoryAddress, owner, testWallet: wallet.address, token, amountBaseUnits: "1000000",
    firebaseVerification: true, frontendVerification: true,
    fundingAuditReconciliation: { status: "matched", events: 13, eventIds: Array.from({ length: 13 }, (_, i) => hash(i)) },
    transactions: BUSINESS_STEPS.map((step, i) => ({ step, hash: hash(i + 1), status: "confirmed", blockNumber: 100 + i })) };
  const opts = { config, owner, testWallet: wallet.address, token };
  let nonce = 7n, pendingNonce = 7n, balance = parseEther("0.001"), price = 10_000_000n, currentReceipt;
  const broadcasts = [], saved = [], reads = [];
  const receipt = { status: 1, blockNumber: 200, blockHash: hash(200), gasUsed: 23_000n, confirmations: async () => 2 };
  const provider = {
    send: async (method, args) => {
      reads.push([method, args]);
      if (method === "eth_getTransactionCount") return `0x${(args[1] === "pending" ? pendingNonce : nonce).toString(16)}`;
      if (method === "eth_getBalance") return `0x${balance.toString(16)}`;
      if (method === "eth_gasPrice") return `0x${price.toString(16)}`;
      throw new Error(`Unexpected ${method}`);
    },
    estimateGas: async () => 23_000n,
    getTransaction: async txHash => txHash === report.transactions.at(-1).hash && report.transactions.at(-1).step !== GAS_RETURN_STEP ? { nonce: 6 } : null,
    getTransactionReceipt: async () => currentReceipt,
    broadcastTransaction: async signed => {
      assert(saved.some(snapshot => snapshot.transactions.at(-1).hash === Transaction.from(signed).hash), "Journal must exist before broadcast.");
      broadcasts.push(signed);
    },
    waitForTransaction: async () => receipt,
    getBlock: async () => ({ hash: hash(200) }),
  };
  const save = async () => saved.push(structuredClone(report));
  return { wallet, report, opts, provider, save, broadcasts, saved, reads,
    setNonce: (a, b = a) => { nonce = a; pendingNonce = b; },
    setBalance: value => { balance = value; }, setReceipt: value => { currentReceipt = value; }, receipt };
}

test("cleanup resume accepts only the complete confirmed business sequence", () => {
  const f = fixture();
  assertCleanupJournal(f.report, f.opts);
  const wrong = structuredClone(f.report); wrong.transactions.splice(3, 1);
  assert.throws(() => assertCleanupJournal(wrong, f.opts), /completed 50\/50/);
  f.report.transactions[2].status = "broadcast";
  assert.throws(() => assertCleanupJournal(f.report, f.opts), /Every business receipt/);
});

test("cleanup resume rejects a different failure stage or active deployment", () => {
  const f = fixture();
  f.report.failedStep = "Release first tranche";
  assert.throws(() => assertCleanupJournal(f.report, f.opts), /cannot repeat business/);
  f.report.failedStep = GAS_RETURN_STEP;
  f.report.factory = Wallet.createRandom().address;
  assert.throws(() => assertCleanupJournal(f.report, f.opts), /factory differs/);
});

test("gas plan accounts for capped fees plus a separate conservative reserve", () => {
  const balance = parseEther("0.001"), plan = gasReturnPlan({ balance, estimate: 23_000n, gasPrice: 10_000_000n });
  assert.equal(plan.value + plan.maximumFee + plan.reserve, balance);
  assert.equal(plan.maximumFee, plan.gasLimit * plan.gasPrice);
  assert.equal(plan.reserve, parseEther("0.00002"));
  assert.equal(plan.gasLimit, 56_000n);
  assert.equal(plan.gasPrice, 20_000_000n);
});

test("fresh balances are read after estimation and signed hash is saved before broadcast", async () => {
  const f = fixture();
  await returnUnusedGas(f);
  assert.equal(f.broadcasts.length, 1);
  const tx = Transaction.from(f.broadcasts[0]);
  assert.equal(tx.to, f.report.owner);
  assert.equal(tx.from, f.wallet.address);
  assert.equal(tx.nonce, 7);
  assert.equal(tx.chainId, 421614n);
  assert.equal(tx.value + tx.gasLimit * tx.gasPrice + parseEther("0.00002"), parseEther("0.001"));
  assert.equal(f.reads.filter(([method]) => method === "eth_getBalance").length, 3);
  assert.equal(f.report.transactions.at(-1).status, "confirmed");
  assert.equal(f.report.gasCleanup.status, "confirmed");
});

test("lost broadcast response resumes only the saved signed transaction", async () => {
  const f = fixture(), broadcast = f.provider.broadcastTransaction;
  f.provider.broadcastTransaction = async signed => { await broadcast(signed); throw new Error("RPC response lost"); };
  await assert.rejects(returnUnusedGas(f), /RPC response lost/);
  const savedHash = f.report.transactions.at(-1).hash;
  assert.equal(f.report.transactions.at(-1).status, "broadcast");
  f.provider.broadcastTransaction = broadcast;
  await returnUnusedGas(f);
  assert.equal(f.broadcasts.length, 2);
  assert.equal(f.broadcasts[0], f.broadcasts[1]);
  assert.equal(f.report.transactions.at(-1).hash, savedHash);
  assert.equal(f.report.transactions.at(-1).status, "confirmed");
});

test("already confirmed cleanup is verified without a second send", async () => {
  const f = fixture();
  await returnUnusedGas(f);
  f.setReceipt(f.receipt);
  await returnUnusedGas(f);
  assert.equal(f.broadcasts.length, 1);
});

test("unrecorded or pending test-wallet transactions stop cleanup", async () => {
  const f = fixture();
  f.setNonce(7n, 8n);
  await assert.rejects(returnUnusedGas(f), /Resolve pending/);
  f.setNonce(8n);
  await assert.rejects(returnUnusedGas(f), /unjournaled test-wallet transaction/);
  assert.equal(f.broadcasts.length, 0);
});

test("a balance change during estimation stops cleanup without signing", async () => {
  const f = fixture();
  f.provider.estimateGas = async () => { f.setBalance(parseEther("0.0009")); return 23_000n; };
  await assert.rejects(returnUnusedGas(f), /balance changed during cleanup/);
  assert.equal(f.broadcasts.length, 0);
});

test("a balance smaller than fees and reserve is retained without sending", async () => {
  const f = fixture();
  f.setBalance(parseEther("0.00001"));
  await returnUnusedGas(f);
  assert.equal(f.broadcasts.length, 0);
  assert.equal(f.report.gasCleanup.status, "reserve-only");
});
