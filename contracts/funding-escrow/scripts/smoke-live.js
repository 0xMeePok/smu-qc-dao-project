import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Contract, HDNodeWallet, JsonRpcProvider, NonceManager, Wallet, getBytes, id, parseEther } from "ethers";
import { prepareOpportunityCommit } from "../../../firebase/functions/auditCanonical.js";
import { prepareStoredProposal } from "../../../firebase/functions/proposalAuditPayload.js";
import { proposalFundingTerms } from "../../../firebase/functions/escrowProposalTerms.js";
import { verifyMinedProposal } from "../../../firebase/functions/proposalAuditRecovery.js";
import { reconcileFundingReceipt } from "../../../firebase/functions/escrowFundingEvents.js";
import { verifyProposalAudit } from "../../../frontend/src/lib/auditRegistry.js";
import config from "../../../firebase/functions/auditRegistry.contract.json" with { type: "json" };
import { GAS_RETURN_STEP, TOKEN_RETURN_STEP, assertCleanupJournal, returnUnusedGas } from "./smoke-cleanup.js";

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

function readClient() {
  const readContract = async ({ address, abi, functionName, args = [], blockNumber }) =>
    new Contract(address, abi, provider)[functionName](...args, ...(blockNumber == null ? [] : [{ blockTag: Number(blockNumber) }]));
  return {
    readContract,
    getTransactionReceipt: async ({ hash }) => { const r = await provider.getTransactionReceipt(hash); return {
      status: r.status === 1 ? "success" : "reverted", transactionHash: r.hash, blockHash: r.blockHash, blockNumber: BigInt(r.blockNumber),
      logs: r.logs.map(log => ({ address: log.address, topics: log.topics, data: log.data, logIndex: log.index })) }; },
    getTransaction: async ({ hash }) => { const tx = await provider.getTransaction(hash); return {
      hash: tx.hash, from: tx.from, to: tx.to, chainId: tx.chainId, input: tx.data, blockHash: tx.blockHash, blockNumber: BigInt(tx.blockNumber) }; },
    getBlock: async ({ blockNumber }) => { const block = await provider.getBlock(Number(blockNumber)); return {
      hash: block.hash, parentHash: block.parentHash, timestamp: BigInt(block.timestamp) }; },
  };
}

async function verifyCompletedSmoke({ owner, child, registry, factory, token, metadata }) {
  assertCleanupJournal(report, { config, owner: owner.address, testWallet: child.address, token: metadata.address });
  const same = (a, b) => assert.equal(a.toLowerCase(), b.toLowerCase());
  const escrow = new Contract(report.escrow, config.escrow.escrowAbi, provider);
  const prepared = prepareStoredProposal(report.proposalRecord), client = readClient();
  same(prepared.entityId, report.proposalId);
  same(prepared.opportunityId, report.postingId);
  same(prepared.expectedResearcher, child.address);
  same(await factory.escrowForProposal(report.proposalId), report.escrow);
  same(await registry.proposalEscrow(report.proposalId), report.escrow);
  same(await registry.acceptedProposalForPosting(report.postingId), report.proposalId);
  for (const [field, expected] of Object.entries({ postingId: report.postingId, proposalId: report.proposalId,
    problemOwner: owner.address, proposalOwner: child.address, token: metadata.address,
    auditRegistry: config.address, tokenRegistry: config.escrow.factoryAddress })) same(await escrow[field](), expected);
  for (const [field, expected] of Object.entries({ state: 2n, fundingTarget: 1_000_000n,
    totalDeposited: 1_000_000n, totalReleased: 1_000_000n, totalRefunded: 0n, outstandingBalance: 0n,
    feePaid: 1_000n, totalDepositCount: 3n })) assert.equal(await escrow[field](), expected, field);
  assert.equal(await token.balanceOf(child.address), 0n);
  assert.equal(await token.balanceOf(report.escrow), 0n);
  assert.equal(await escrow.contributions(owner.address), 600_000n);
  assert.equal(await escrow.contributions(child.address), 400_000n);
  const safeBlock = BigInt(await provider.send("eth_blockNumber", [])) - 1n, reconciled = [];
  const childSteps = new Set(["Create proposal and escrow atomically", "Approve second deposit",
    "Second depositor completes funding", "Proposal owner approves first payment", "Submit milestone evidence",
    "Proposal owner approves milestone", TOKEN_RETURN_STEP]);
  const tokenSteps = new Set(["Approve owner deposit", "Fund second depositor with mock USDC", "Approve second deposit", TOKEN_RETURN_STEP]);
  for (const entry of report.transactions.filter(item => item.step !== GAS_RETURN_STEP)) {
    const receipt = await provider.getTransactionReceipt(entry.hash), tx = await provider.getTransaction(entry.hash);
    assert.equal(receipt?.status, 1, entry.step);
    assert.equal(receipt.blockNumber, entry.blockNumber, entry.step);
    assert(BigInt(receipt.blockNumber) <= safeBlock, `${entry.step} needs two confirmations.`);
    assert.equal(receipt.blockHash, (await provider.getBlock(receipt.blockNumber)).hash);
    same(tx.hash, entry.hash);
    assert.equal(tx.chainId, 421614n);
    same(tx.from, childSteps.has(entry.step) ? child.address : owner.address);
    const target = entry.step === "Fund test wallet gas" ? child.address
      : tokenSteps.has(entry.step) ? metadata.address
        : ["Create labelled test posting", "Create proposal and escrow atomically"].includes(entry.step) ? config.address : report.escrow;
    same(tx.to, target);
    if (entry.step === TOKEN_RETURN_STEP) {
      const returned = token.interface.parseTransaction({ data: tx.data });
      assert.equal(returned.name, "transfer");
      same(returned.args[0], owner.address);
      assert.equal(returned.args[1], 999_000n);
    }
    const hasAnchor = receipt.logs.some(log => {
      if (log.address.toLowerCase() !== config.address.toLowerCase()) return false;
      try { return registry.interface.parseLog(log)?.name === "FundingEventAnchored"; } catch { return false; }
    });
    if (hasAnchor) reconciled.push(...await reconcileFundingReceipt({ client, config, expected: prepared,
      escrowAddress: report.escrow, transactionHash: entry.hash, safeBlock }));
  }
  assert.equal(reconciled.length, 13);
  assert.equal(reconciled.filter(event => event.eventType === "Deposit").length, 3);
  const releases = reconciled.filter(event => event.eventType === "TrancheReleased");
  assert.equal(releases.length, 2);
  for (const release of releases) { assert.equal(release.amountBaseUnits, "500000"); assert.equal(release.feeBaseUnits, "500"); }
  assert.deepEqual(reconciled.map(event => event.id), report.fundingAuditReconciliation.eventIds);
  assert.equal((await verifyMinedProposal(report.proposalRecord, client)).status, "confirmed");
  const noWrite = () => { throw new Error("Cleanup validation cannot request a business transaction."); };
  assert.equal((await verifyProposalAudit(prepared, { adapters: { readContract: client.readContract,
    writeContract: noWrite, waitForTransactionReceipt: noWrite }, maxReadRetries: 0 })).verified, true);
  report.cleanupValidation = { status: "verified", blockNumber: Number(safeBlock), businessReceipts: report.transactions.filter(item => item.step !== GAS_RETURN_STEP).length };
  await save();
}

async function completeSmoke(child) {
  step = GAS_RETURN_STEP;
  // This is also a durable checkpoint if the process stops during final cleanup.
  report.failedStep = GAS_RETURN_STEP;
  await save();
  await returnUnusedGas({ provider, wallet: child, report, save });
  Object.assign(report, { status: "passed", grossReleasedBaseUnits: "1000000", feeBaseUnits: "1000",
    refundedBaseUnits: "0", escrowBalanceBaseUnits: "0", mockTokensReturned: true,
    remainingTestWalletGasWei: BigInt(await provider.send("eth_getBalance", [child.address, "latest"])).toString() });
  delete report.failedStep;
  delete report.failureReason;
  await save();
  console.log(`Live smoke passed; evidence: ${reportFile.pathname}`);
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
  const cleanupResume = saved?.failedStep === GAS_RETURN_STEP;
  if (saved) {
    assert.equal(saved.registry, config.address);
    assert.equal(saved.owner, owner.address);
    assert.equal(saved.testWallet, child.address);
    if (cleanupResume) assertCleanupJournal(saved, { config, owner: owner.address, testWallet: child.address, token: metadata.address });
    else {
      assert.equal(saved.failedStep, "Verify real frontend and Firebase proposal reads");
      assert(saved.transactions.every(entry => entry.status === "confirmed"));
      assert(saved.transactions.length <= 3, "Later-stage failures require manual recovery.");
    }
  }
  const stamp = saved ? Number(resume.match(/live-smoke-(\d+)\.json$/)?.[1]) : Date.now();
  assert(Number.isSafeInteger(stamp));
  reportFile = new URL(`../deployments/live-smoke-${stamp}.json`, import.meta.url);
  report = saved ?? { chainId: 421614, registry: config.address, factory: config.escrow.factoryAddress,
    owner: owner.address, testWallet: child.address, testWalletDerivation: "BIP32 seed = supplied deployer key bytes; m/44'/60'/0'/0/109",
    token: metadata.address, amountBaseUnits: "1000000", status: "running", transactions: [] };
  await save();
  if (cleanupResume) {
    step = GAS_RETURN_STEP;
    await verifyCompletedSmoke({ owner, child, registry, factory, token, metadata });
    await completeSmoke(child);
    return;
  }
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
    summary: "One mock USDC; top-ups, dual approval, 50/50 payments, completion evidence and funding audit events.",
    amount: 1, currency: "USDC", milestones: "50% on dual approval, 50% after accepted delivery evidence and the configured funder vote.",
    attachments: [], audit: { schemaVersion: 1, chainId: 421614, status: "pending", attemptCount: 1, blockNumber: 0, lastError: "" } };
  record.fundingTerms = proposalFundingTerms({ form: { amount: "1", milestones: record.milestones,
    tranchePercentages: "50,50", reviewDays: "7", funderVoting: true }, currency: "USDC", config });
  const prepared = prepareStoredProposal(record);
  const created = await send("Create proposal and escrow atomically", () => registry.connect(childSigner).commitProposalWithEscrow(...prepared.args));
  record.audit.transactionHash = created.hash;
  const escrowAddress = await registry.proposalEscrow(prepared.entityId);
  const escrow = new Contract(escrowAddress, config.escrow.escrowAbi, ownerSigner);
  report.postingId = posting.entityId; report.proposalId = prepared.entityId; report.escrow = escrowAddress;
  report.proposalRecord = record;
  assert.equal(await factory.escrowForProposal(prepared.entityId), escrowAddress);
  const client = readClient(), { readContract } = client;
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
  assert.equal(await escrow.totalReleased(), 500_000n);
  assert.equal(await escrow.feePaid(), 500n);
  assert.equal(await registry.acceptedProposalForPosting(posting.entityId), prepared.entityId);
  const evidence = id(`escrow-smoke-evidence-${stamp}`);
  await send("Submit milestone evidence", () => escrow.connect(childSigner).submitMilestone(1, evidence));
  await send("Problem owner approves milestone", () => escrow.approveMilestone(selection, 1, evidence));
  await send("Proposal owner approves milestone", () => escrow.connect(childSigner).approveMilestone(selection, 1, evidence));
  await send("60 percent funder majority vote", () => escrow.voteMilestone(1, evidence, true));
  assert.equal(await escrow.yesWeight(), 600_000n);
  await send("Release voted second tranche", () => escrow.releaseMilestone(selection, 1, evidence));
  assert.equal(await escrow.totalReleased(), 1_000_000n);
  assert.equal(await escrow.feePaid(), 1_000n);
  assert.equal(await escrow.totalRefunded(), 0n);
  assert.equal(await escrow.outstandingBalance(), 0n);
  assert.equal(await token.balanceOf(escrowAddress), 0n);
  assert.equal(await escrow.state(), 2n);
  step = "Reconcile live funding events with audit anchors";
  const safeBlock = BigInt(await provider.getBlockNumber()) - 1n;
  const reconciled = [];
  for (const entry of report.transactions) {
    const receipt = await provider.getTransactionReceipt(entry.hash);
    const hasFundingAnchor = receipt.logs.some(log => {
      if (log.address.toLowerCase() !== config.address.toLowerCase()) return false;
      try { return registry.interface.parseLog(log)?.name === "FundingEventAnchored"; } catch { return false; }
    });
    if (hasFundingAnchor) reconciled.push(...await reconcileFundingReceipt({ client, config, expected: prepared,
      escrowAddress, transactionHash: entry.hash, safeBlock }));
  }
  assert.equal(reconciled.filter(event => event.eventType === "Deposit").length, 3);
  assert.equal(reconciled.filter(event => event.eventType === "TrancheReleased").length, 2);
  assert.equal(reconciled.filter(event => event.eventType === "SelectionLocked").length, 1);
  report.fundingAuditReconciliation = { status: "matched", events: reconciled.length,
    eventIds: reconciled.map(event => event.id) };
  await save();
  const returnTokens = await token.balanceOf(child.address);
  await send(TOKEN_RETURN_STEP, () => token.connect(childSigner).transfer(owner.address, returnTokens));
  assert.equal(await token.balanceOf(owner.address), initialTokens);
  await completeSmoke(child);
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
