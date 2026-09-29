import assert from "node:assert/strict";
import { keccak256, parseEther } from "ethers";

export const GAS_RETURN_STEP = "Return unused test-wallet gas";
export const TOKEN_RETURN_STEP = "Return all test-wallet mock tokens";
export const BUSINESS_STEPS = [
  "Create labelled test posting", "Create proposal and escrow atomically", "Approve owner deposit",
  "Initial owner deposit", "Owner deposit top-up", "Fund second depositor with mock USDC",
  "Approve second deposit", "Second depositor completes funding", "Lock funded selection",
  "Problem owner approves first payment", "Proposal owner approves first payment", "Release first tranche",
  "Submit milestone evidence", "Problem owner approves milestone", "Proposal owner approves milestone",
  "60 percent funder majority vote", "Release voted second tranche", TOKEN_RETURN_STEP,
];
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const RESERVE_WEI = parseEther("0.00002");

export function assertCleanupJournal(report, { config, owner, testWallet, token }) {
  assert(["failed", "running"].includes(report.status), "Only an unfinished smoke run may resume cleanup.");
  assert.equal(report.failedStep, GAS_RETURN_STEP, "Cleanup resume cannot repeat business transactions.");
  assert.equal(report.chainId, 421614);
  for (const [key, value] of Object.entries({ registry: config.address, factory: config.escrow.factoryAddress, owner, testWallet, token })) {
    assert(same(report[key], value), `Saved ${key} differs from the active smoke configuration.`);
  }
  assert.equal(report.amountBaseUnits, "1000000");
  assert.equal(report.firebaseVerification, true);
  assert.equal(report.frontendVerification, true);
  assert.equal(report.fundingAuditReconciliation?.status, "matched");
  assert.equal(report.fundingAuditReconciliation.events, 13);
  assert.equal(new Set(report.fundingAuditReconciliation.eventIds).size, 13);
  const entries = [...report.transactions];
  if (entries[0]?.step === "Fund test wallet gas") entries.shift();
  if (entries.at(-1)?.step === GAS_RETURN_STEP) entries.pop();
  assert.deepEqual(entries.map(entry => entry.step), BUSINESS_STEPS, "Only the completed 50/50 smoke sequence may resume cleanup.");
  for (const entry of report.transactions.filter(entry => entry.step !== GAS_RETURN_STEP)) {
    assert.equal(entry.status, "confirmed", "Every business receipt must already be confirmed.");
    assert.match(entry.hash, /^0x[0-9a-fA-F]{64}$/);
    assert(Number.isSafeInteger(entry.blockNumber));
  }
  assert.equal(new Set(report.transactions.map(entry => entry.hash.toLowerCase())).size, report.transactions.length);
}

export function gasReturnPlan({ balance, estimate, gasPrice }) {
  assert(balance >= 0n && estimate > 0n && gasPrice > 0n);
  // Arbitrum's gas estimate includes its L1 posting component, which can change.
  // Budget the actual capped transaction fee separately from a small ETH reserve.
  const gasLimit = estimate * 2n + 10_000n, cappedGasPrice = gasPrice * 2n;
  const maximumFee = gasLimit * cappedGasPrice;
  return { gasLimit, gasPrice: cappedGasPrice, maximumFee, reserve: RESERVE_WEI,
    value: balance > maximumFee + RESERVE_WEI ? balance - maximumFee - RESERVE_WEI : 0n };
}

export async function returnUnusedGas({ provider, wallet, report, save }) {
  const freshBalance = async tag => BigInt(await provider.send("eth_getBalance", [wallet.address, tag]));
  let entry = report.transactions.find(item => item.step === GAS_RETURN_STEP);
  if (!entry) {
    const [latestNonce, pendingNonce, balance, pendingBalance, price] = await Promise.all([
      provider.send("eth_getTransactionCount", [wallet.address, "latest"]),
      provider.send("eth_getTransactionCount", [wallet.address, "pending"]),
      freshBalance("latest"), freshBalance("pending"), provider.send("eth_gasPrice", []),
    ]);
    assert.equal(BigInt(latestNonce), BigInt(pendingNonce), "Resolve pending test-wallet transactions before cleanup.");
    assert.equal(balance, pendingBalance, "Test-wallet balance is still changing; retry cleanup after confirmation.");
    const returned = report.transactions.find(item => item.step === TOKEN_RETURN_STEP);
    const lastTokenTx = await provider.getTransaction(returned.hash);
    assert.equal(BigInt(latestNonce), BigInt(lastTokenTx.nonce) + 1n,
      "An unjournaled test-wallet transaction exists after token return; inspect it before cleanup.");
    const estimate = await provider.estimateGas({ from: wallet.address, to: report.owner,
      value: balance > RESERVE_WEI ? balance - RESERVE_WEI : 0n });
    // Re-read after estimation; provider.getBalance('latest') can be briefly cached.
    const currentBalance = await freshBalance("pending");
    assert.equal(currentBalance, balance, "Test-wallet balance changed during cleanup preparation.");
    const plan = gasReturnPlan({ balance: currentBalance, estimate, gasPrice: BigInt(price) });
    report.gasCleanup = { status: plan.value ? "prepared" : "reserve-only", reserveWei: plan.reserve.toString(),
      maximumFeeWei: plan.maximumFee.toString(), returnedWei: plan.value.toString() };
    if (!plan.value) { await save(); return; }
    const request = { to: report.owner, value: plan.value.toString(), gasPrice: plan.gasPrice.toString(),
      gasLimit: plan.gasLimit.toString(), nonce: Number(BigInt(latestNonce)), chainId: 421614, type: 0 };
    const signed = await wallet.signTransaction(request);
    entry = { step: GAS_RETURN_STEP, hash: keccak256(signed), status: "broadcast", request };
    report.transactions.push(entry);
    // Save the deterministic hash and request before any broadcast. A resume can
    // only recreate these exact bytes, even if the RPC response is lost.
    await save();
  }
  assert(["broadcast", "confirmed"].includes(entry.status));
  assert(entry.request && same(entry.request.to, report.owner), "Saved gas cleanup must return only to the owner.");
  assert.equal(entry.request.chainId, 421614);
  assert.equal(entry.request.type, 0);
  assert.equal(Object.keys(entry.request).sort().join(","), "chainId,gasLimit,gasPrice,nonce,to,type,value");
  const signed = await wallet.signTransaction(entry.request);
  assert.equal(keccak256(signed), entry.hash, "Saved gas cleanup hash differs from its signed request.");
  let receipt = await provider.getTransactionReceipt(entry.hash);
  if (!receipt) {
    try { await provider.broadcastTransaction(signed); }
    catch (error) {
      if (!await provider.getTransaction(entry.hash)) throw error;
    }
    receipt = await provider.waitForTransaction(entry.hash, 2, 120_000);
  } else if (await receipt.confirmations() < 2) {
    receipt = await provider.waitForTransaction(entry.hash, 2, 120_000);
  }
  assert.equal(receipt?.status, 1, "Gas return has not successfully confirmed.");
  const canonical = await provider.getBlock(receipt.blockNumber);
  assert.equal(receipt.blockHash, canonical.hash, "Gas return is not in the canonical block.");
  Object.assign(entry, { status: "confirmed", blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() });
  report.gasCleanup.status = "confirmed";
  await save();
}
