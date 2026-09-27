import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Contract, HDNodeWallet, JsonRpcProvider, NonceManager, Wallet, getBytes, id, parseEther } from "ethers";
import { prepareOpportunityCommit } from "../../../firebase/functions/auditCanonical.js";
import { prepareStoredProposal } from "../../../firebase/functions/proposalAuditPayload.js";
import { proposalFundingTerms } from "../../../firebase/functions/escrowProposalTerms.js";
import { verifyMinedProposal } from "../../../firebase/functions/proposalAuditRecovery.js";
import { verifyProposalAudit } from "../../../frontend/src/lib/auditRegistry.js";
import config from "../../../firebase/functions/auditRegistry.contract.json" with { type: "json" };

// Explicit opt-in: this creates labelled testnet records and temporarily uses
// one mock USDC. It never writes Firestore or deploys a frontend/backend.
const provider = new JsonRpcProvider(process.env.ARBITRUM_SEPOLIA_RPC_URL, 421614, { staticNetwork: true });
let report, reportFile, step = "preflight";
const save = () => fs.writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
async function send(label, operation) {
  step = label;
  const previous = report.transactions.find(entry => entry.step === label);
  if (previous) {
    assert.equal(previous.status, "confirmed", "Resolve the saved transaction before resuming.");
    const receipt = await provider.getTransactionReceipt(previous.hash);
    assert.equal(receipt?.status, 1);
    return receipt;
  }
  const tx = await operation();
  const entry = { step: label, hash: tx.hash, status: "broadcast" };
  report.transactions.push(entry);
  await save();
  console.log(`${label}: ${tx.hash}`);
  const receipt = await tx.wait(2, 120_000);
  assert.equal(receipt?.status, 1);
  Object.assign(entry, { status: "confirmed", blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() });
  await save();
  return receipt;
}

async function main() {
  assert.equal(process.env.ESCROW_LIVE_SMOKE_ACK, "true");
  assert.equal(BigInt(await provider.send("eth_chainId", [])), 421614n);
  assert.equal(config.contractName, "EscrowAuditRegistry");
  const owner = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  // Recoverable from the same supplied key, without persisting another secret.
  const child = HDNodeWallet.fromSeed(getBytes(owner.privateKey)).derivePath("m/44'/60'/0'/0/109").connect(provider);
  const ownerSigner = new NonceManager(owner), childSigner = new NonceManager(child);
  const registry = new Contract(config.address, config.abi, ownerSigner);
  const factory = new Contract(config.escrow.factoryAddress, config.escrow.factoryAbi, ownerSigner);
  assert.equal(await factory.owner(), owner.address);
  assert.equal(await factory.platformSigner(), owner.address);
  assert.equal(await factory.feeBps(), 10n);
  assert.equal(await registry.fundingFactory(), config.escrow.factoryAddress);
  const metadata = config.escrow.tokens.find(token => token.symbol === "USDC");
  assert.equal(metadata.decimals, 6);
  const token = new Contract(metadata.address, ["function balanceOf(address) view returns(uint256)",
    "function approve(address,uint256) returns(bool)", "function transfer(address,uint256) returns(bool)"], ownerSigner);
  const initialTokens = await token.balanceOf(owner.address);
  assert(initialTokens >= 1_000_000n);
  assert.equal(await token.balanceOf(child.address), 0n, "Inspect a previous smoke run before reusing its test wallet.");
  const resume = process.env.ESCROW_SMOKE_RESUME;
  const saved = resume ? JSON.parse(await fs.readFile(resume, "utf8")) : null;
  if (saved) {
    assert.equal(saved.registry, config.address);
    assert.equal(saved.owner, owner.address);
    assert.equal(saved.testWallet, child.address);
    assert.equal(saved.failedStep, "Verify real frontend and Firebase proposal reads");
    assert(saved.transactions.every(entry => entry.status === "confirmed"));
    assert(saved.transactions.length <= 3, "Later-stage failures require manual recovery.");
  }
  const stamp = saved ? Number(resume.match(/live-smoke-(\d+)\.json$/)?.[1]) : Date.now();
  assert(Number.isSafeInteger(stamp));
  reportFile = new URL(`../deployments/live-smoke-${stamp}.json`, import.meta.url);
  report = saved ?? { chainId: 421614, registry: config.address, factory: config.escrow.factoryAddress,
    owner: owner.address, testWallet: child.address, testWalletDerivation: "BIP32 seed = supplied deployer key bytes; m/44'/60'/0'/0/109",
    token: metadata.address, amountBaseUnits: "1000000", status: "running", transactions: [] };
  await save();
  const childGas = await provider.getBalance(child.address);
  if (childGas < parseEther("0.001")) {
    await send("Fund test wallet gas", () => ownerSigner.sendTransaction({ to: child.address, value: parseEther("0.001") - childGas }));
  }
  const postingId = `escrow-smoke-posting-${stamp}`, proposalId = `escrow-smoke-proposal-${stamp}`;
  const expiry = Number((await provider.getBlock("latest")).timestamp) + 7 * 86400;
  const posting = prepareOpportunityCommit({ recordId: postingId, actor: owner.address, kind: 0, expiresAt: expiry,
    payload: { title: "Escrow deployment smoke test", amount: "1", currency: "USDC" } });
  await send("Create labelled test posting", () => registry.commitOpportunity(...posting.args));
  const record = { id: proposalId, problemId: postingId, postingOwnerId: owner.address, researcherId: child.address,
    opportunityType: "business-problem", status: "submitted", title: "Escrow deployment smoke test",
    summary: "One mock USDC; top-ups, dual approval, voting, fees and partial refunds.",
    amount: 1, currency: "USDC", milestones: "40% first payment, 30% voted milestone, 30% refunded after administrative void.",
    attachments: [], audit: { schemaVersion: 1, chainId: 421614, status: "pending", attemptCount: 1, blockNumber: 0, lastError: "" } };
  record.fundingTerms = proposalFundingTerms({ form: { amount: "1", milestones: record.milestones,
    tranchePercentages: "40,30,30", reviewDays: "7", funderVoting: true }, currency: "USDC", config });
  const prepared = prepareStoredProposal(record);
  const created = await send("Create proposal and escrow atomically", () => registry.connect(childSigner).commitProposalWithEscrow(...prepared.args));
  record.audit.transactionHash = created.hash;
  const escrowAddress = await registry.proposalEscrow(prepared.entityId);
  const escrow = new Contract(escrowAddress, config.escrow.escrowAbi, ownerSigner);
  report.postingId = posting.entityId; report.proposalId = prepared.entityId; report.escrow = escrowAddress;
  report.proposalRecord = record;
  assert.equal(await factory.escrowForProposal(prepared.entityId), escrowAddress);
  const readContract = async ({ address, abi, functionName, args = [] }) => new Contract(address, abi, provider)[functionName](...args);
  const client = {
    readContract,
    getTransactionReceipt: async ({ hash }) => { const r = await provider.getTransactionReceipt(hash); return {
      status: r.status === 1 ? "success" : "reverted", transactionHash: r.hash, blockHash: r.blockHash, blockNumber: BigInt(r.blockNumber) }; },
    getTransaction: async ({ hash }) => { const tx = await provider.getTransaction(hash); return {
      hash: tx.hash, from: tx.from, to: tx.to, chainId: tx.chainId, input: tx.data, blockHash: tx.blockHash, blockNumber: BigInt(tx.blockNumber) }; },
    getBlock: ({ blockNumber }) => provider.getBlock(Number(blockNumber)),
  };
  step = "Verify real frontend and Firebase proposal reads";
  const backendCheck = await verifyMinedProposal(record, client);
  report.firebaseVerification = backendCheck.status === "confirmed";
  assert.equal(backendCheck.status, "confirmed");
  const noWrite = () => { throw new Error("Read-only verification must not request a wallet transaction."); };
  const frontendCheck = await verifyProposalAudit(prepared, { adapters: {
    readContract, writeContract: noWrite, waitForTransactionReceipt: noWrite,
  }, maxReadRetries: 0 });
  report.frontendMismatches = frontendCheck.mismatches;
  assert.equal(frontendCheck.verified, true);
  report.firebaseVerification = true; report.frontendVerification = true;
  await save();
  await send("Approve owner deposit", () => token.approve(escrowAddress, 600_000n));
  await send("Initial owner deposit", () => escrow.deposit(300_000n));
  await send("Owner deposit top-up", () => escrow.deposit(300_000n));
  assert.equal(await escrow.contributions(owner.address), 600_000n);
  assert.equal(await escrow.depositCounts(owner.address), 2n);
  await send("Fund second depositor with mock USDC", () => token.transfer(child.address, 400_000n));
  await send("Approve second deposit", () => token.connect(childSigner).approve(escrowAddress, 400_000n));
  await send("Second depositor completes funding", () => escrow.connect(childSigner).deposit(400_000n));
  const selection = id(`escrow-smoke-selection-${stamp}`);
  await send("Lock funded selection", () => escrow.lockSelection(selection, child.address));
  await send("Problem owner approves first payment", () => escrow.approveSelection(selection));
  await send("Proposal owner approves first payment", () => escrow.connect(childSigner).approveSelection(selection));
  await send("Release first tranche", () => escrow.release(selection));
  assert.equal(await escrow.totalReleased(), 400_000n);
  assert.equal(await escrow.feePaid(), 400n);
  const evidence = id(`escrow-smoke-evidence-${stamp}`);
  await send("Submit milestone evidence", () => escrow.connect(childSigner).submitMilestone(1, evidence));
  await send("Problem owner approves milestone", () => escrow.approveMilestone(selection, 1, evidence));
  await send("Proposal owner approves milestone", () => escrow.connect(childSigner).approveMilestone(selection, 1, evidence));
  await send("60 percent funder majority vote", () => escrow.voteMilestone(1, evidence, true));
  assert.equal(await escrow.yesWeight(), 600_000n);
  await send("Release voted second tranche", () => escrow.releaseMilestone(selection, 1, evidence));
  assert.equal(await escrow.totalReleased(), 700_000n);
  assert.equal(await escrow.feePaid(), 700n);
  await send("Admin voids unpaid final tranche", () => escrow.voidEscrow(id("Completed deployment smoke test: refund unpaid third tranche")));
  assert.equal(await escrow.refundPool(), 300_000n);
  const ownerSummary = await escrow.depositorSummary(owner.address), childSummary = await escrow.depositorSummary(child.address);
  assert.equal(ownerSummary.claimable, 180_000n); assert.equal(childSummary.claimable, 120_000n);
  await send("Second funder pulls partial refund", () => escrow.connect(childSigner).claimRefund());
  await send("Owner pulls partial refund", () => escrow.claimRefund());
  assert.equal(await escrow.totalRefunded(), 300_000n);
  assert.equal(await escrow.feePaid(), 700n);
  assert.equal(await escrow.outstandingBalance(), 0n);
  assert.equal(await token.balanceOf(escrowAddress), 0n);
  assert.equal(await escrow.state(), 3n);
  const returnTokens = await token.balanceOf(child.address);
  await send("Return all test-wallet mock tokens", () => token.connect(childSigner).transfer(owner.address, returnTokens));
  assert.equal(await token.balanceOf(owner.address), initialTokens);
  const balance = await provider.getBalance(child.address);
  const gasPrice = (await provider.getFeeData()).gasPrice;
  const estimate = await provider.estimateGas({ from: child.address, to: owner.address, value: 1n });
  const gasLimit = estimate * 3n / 2n;
  const gasReserve = gasLimit * gasPrice;
  if (balance > gasReserve) await send("Return unused test-wallet gas", () => childSigner.sendTransaction({
    to: owner.address, value: balance - gasReserve, gasPrice, gasLimit, type: 0 }));
  Object.assign(report, { status: "passed", grossReleasedBaseUnits: "700000", feeBaseUnits: "700",
    refundedBaseUnits: "300000", escrowBalanceBaseUnits: "0", mockTokensReturned: true,
    remainingTestWalletGasWei: (await provider.getBalance(child.address)).toString() });
  delete report.failedStep;
  delete report.failureReason;
  await save();
  console.log(`Live smoke passed; evidence: ${reportFile.pathname}`);
}
try { await main(); }
catch (error) {
  let reason = String(error.shortMessage ?? error.message ?? "check failed");
  for (const name of ["DEPLOYER_PRIVATE_KEY", "ARBITRUM_SEPOLIA_RPC_URL", "ETHERSCAN_API_KEY"]) {
    if (process.env[name]) reason = reason.split(process.env[name]).join("[redacted]");
  }
  reason = reason.replace(/(?:0x)?[0-9a-fA-F]{64}/g, "[bytes32]").slice(0, 500);
  if (report) { report.status = "failed"; report.failedStep = step; report.failureReason = reason; await save(); }
  console.error(`Live smoke failed at: ${step}. Inspect the saved transaction journal before retrying. Code: ${error.code ?? "check-failed"}`);
  console.error(reason);
  process.exitCode = 1;
} finally { provider.destroy(); }
