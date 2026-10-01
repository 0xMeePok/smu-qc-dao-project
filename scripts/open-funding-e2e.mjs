/**
 * Local integration smoke test: real grant contracts + production backend services
 * + Firestore emulator. No .env, deployed addresses, live RPC, or wallet keys are used.
 *
 * Start Firestore with a demo project, compile funding-escrow, then run:
 * FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/open-funding-e2e.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const contractRoot = path.join(root, "contracts/funding-escrow");
const contractRequire = createRequire(path.join(contractRoot, "package.json"));
const backendRequire = createRequire(path.join(root, "firebase/functions/package.json"));
const loadContract = name => import(pathToFileURL(contractRequire.resolve(name)));
const loadBackend = name => import(pathToFileURL(backendRequire.resolve(name)));

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(emulatorHost ?? "")) {
  throw new Error("Set FIRESTORE_EMULATOR_HOST to a local Firestore emulator; this test refuses production.");
}
const suffix = Date.now().toString(36);
const projectId = process.env.OPEN_FUNDING_E2E_PROJECT ?? `demo-open-funding-e2e-${suffix}`;
if (!/^demo-[a-z0-9-]+$/.test(projectId)) throw new Error("Use a demo- Firebase project for this local test.");

const [{ createHardhatRuntimeEnvironment }, { default: hardhatEthers }, admin, firestore] = await Promise.all([
  loadContract("hardhat/hre"), loadContract("@nomicfoundation/hardhat-ethers"),
  loadBackend("firebase-admin/app"), loadBackend("firebase-admin/firestore"),
]);
const { getOpenFundingSummary, prepareOpenFundingAction, syncOpenFunding } = await import("../firebase/functions/openFunding.js");
const { syncEscrowFunding, prepareEscrowDeposit } = await import("../firebase/functions/escrowFunding.js");
const { prepareOpportunityCommit } = await import("../firebase/functions/auditCanonical.js");
const { fundingOpportunityAuditPayload } = await import("../firebase/functions/opportunityAuditPayload.js");
const { prepareStoredProposal } = await import("../firebase/functions/proposalAuditPayload.js");
const { proposalFundingTerms } = await import("../firebase/functions/escrowProposalTerms.js");

// A separate HRE prevents loading the repository's deployment configuration/.env.
const hre = await createHardhatRuntimeEnvironment({
  plugins: [hardhatEthers],
  paths: { artifacts: path.join(contractRoot, "artifacts"), cache: path.join("/tmp", "qcdao-open-funding-e2e-cache") },
  networks: { grants: { type: "edr-simulated", chainType: "generic", chainId: 421614 } },
}, {}, contractRoot);
const connection = await hre.network.create("grants");
const { ethers } = connection;
const [platform, owner, researcherA, researcherB, researcherC, outsider, adminSigner] = await ethers.getSigners();
const provider = ethers.provider;
const app = admin.initializeApp({ projectId }, `open-funding-e2e-${Date.now()}`);
const db = firestore.getFirestore(app);
const problemId = `grant-${suffix}`;
const ids = [`grant-a-${suffix}`, `grant-b-${suffix}`, `grant-c-${suffix}`];
const units = dollars => BigInt(dollars) * 1_000_000n;
const lower = address => address.toLowerCase();
let checks = 0;
const passed = label => { checks++; console.log(`PASS ${label}`); };

const receiptFor = async hash => {
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt) throw new Error(`Local transaction ${hash} has not been mined.`);
  return { status: receipt.status === 1 ? "success" : "reverted", transactionHash: receipt.hash,
    to: receipt.to, from: receipt.from, blockHash: receipt.blockHash, blockNumber: BigInt(receipt.blockNumber),
    logs: receipt.logs.map(log => ({ address: log.address, topics: log.topics, data: log.data,
      logIndex: log.index, transactionHash: receipt.hash, blockHash: receipt.blockHash, blockNumber: BigInt(receipt.blockNumber) })) };
};
const client = {
  getChainId: async () => Number((await provider.getNetwork()).chainId),
  getBlockNumber: async () => BigInt(await provider.send("eth_blockNumber", [])),
  getBlock: async ({ blockNumber, blockTag } = {}) => {
    const block = await provider.getBlock(blockNumber === undefined ? blockTag ?? "latest" : Number(blockNumber));
    return { hash: block.hash, parentHash: block.parentHash, timestamp: BigInt(block.timestamp), number: BigInt(block.number) };
  },
  getTransactionReceipt: ({ hash }) => receiptFor(hash),
  getTransaction: async ({ hash }) => {
    const tx = await provider.getTransaction(hash);
    return { hash: tx.hash, to: tx.to, from: tx.from, chainId: Number(tx.chainId), input: tx.data,
      blockNumber: BigInt(tx.blockNumber), blockHash: tx.blockHash };
  },
  readContract: async ({ address, abi, functionName, args = [], blockNumber }) => {
    const contract = new ethers.Contract(address, abi, provider);
    return contract[functionName](...args, ...(blockNumber === undefined ? [] : [{ blockTag: Number(blockNumber) }]));
  },
  simulateContract: async ({ address, abi, functionName, args = [], account }) => {
    const signer = await provider.getSigner(typeof account === "string" ? account : account.address);
    return new ethers.Contract(address, abi, signer)[functionName].staticCall(...args);
  },
  getLogs: async ({ address, event, args = {}, fromBlock, toBlock }) => {
    const iface = new ethers.Interface([event]);
    const topics = iface.encodeFilterTopics(event.name, event.inputs.map(input => input.indexed ? args[input.name] ?? null : null));
    return (await provider.getLogs({ address, topics, fromBlock: Number(fromBlock), toBlock: Number(toBlock) }))
      .map(log => ({ address: log.address, topics: log.topics, data: log.data, logIndex: log.index,
        transactionHash: log.transactionHash, blockHash: log.blockHash, blockNumber: BigInt(log.blockNumber) }));
  },
};
const confirm = async promise => {
  const tx = await promise;
  await tx.wait();
  await provider.send("evm_mine", []); // Production services require one confirmed successor block.
  return tx;
};
const chainNow = async () => firestore.Timestamp.fromMillis(Number((await client.getBlock()).timestamp) * 1000);

try {
  const token = await ethers.deployContract("EscrowTestToken", [6]);
  const registry = await ethers.deployContract("EscrowAuditRegistry", [adminSigner.address]);
  const factory = await ethers.deployContract("FundingEscrowFactory", [adminSigner.address, platform.address,
    [await token.getAddress()], 0, await registry.getAddress()]);
  await confirm(registry.connect(adminSigner).setFundingFactory(await factory.getAddress()));
  const poolArtifact = await hre.artifacts.readArtifact("OpenFundingPool");
  const escrowArtifact = await hre.artifacts.readArtifact("FundingEscrow");
  const config = { contractName: "EscrowAuditRegistry", chainId: 421614, entityIdScheme: 2,
    address: lower(await registry.getAddress()), abi: JSON.parse(registry.interface.formatJson()),
    escrow: { factoryAddress: lower(await factory.getAddress()), factoryAbi: JSON.parse(factory.interface.formatJson()),
      escrowAbi: escrowArtifact.abi, openFundingPoolAbi: poolArtifact.abi,
      tokens: [{ address: lower(await token.getAddress()), symbol: "USDC", decimals: 6 }] } };
  const expiresAt = firestore.Timestamp.fromMillis(Number((await client.getBlock()).timestamp + 30n * 86400n) * 1000);
  const posting = { id: problemId, ownerId: lower(owner.address), opportunityType: "open-funding", organisation: "Local E2E",
    title: "100,000 USDC quantum solutions grant", fundingThesis: "Two independently funded solutions to one problem.",
    eligibilityNotes: "Researchers with a reproducible prototype.", categories: ["quantum-adjacent"], tags: ["local-test"],
    amount: 100000, currency: "USDC", expiresAt, status: "submitted", attachments: [] };
  await Promise.all([owner, researcherA, researcherB, researcherC, outsider].map(signer =>
    db.collection("users").doc(lower(signer.address)).set({ role: 0, suspended: false, onboardingComplete: true })));
  const preparedPosting = prepareOpportunityCommit({ recordId: problemId, actor: posting.ownerId,
    payload: fundingOpportunityAuditPayload(posting), kind: 1, expiresAt, hashScheme: 1 });
  const posted = await confirm(registry.connect(owner)[preparedPosting.functionName](...preparedPosting.args));
  posting.audit = { schemaVersion: 1, chainId: 421614, status: "confirmed", transactionHash: posted.hash,
    registryAddress: config.address, blockNumber: (await receiptFor(posted.hash)).blockNumber.toString() };
  await db.collection("problems").doc(problemId).set(posting);
  const options = uid => ({ db, client, config, uid: lower(uid), problemId });
  const summary = (uid, selectedProblemId = problemId) => getOpenFundingSummary({ ...options(uid), problemId: selectedProblemId });
  const action = async (signer, name, extra = {}) => {
    const actionOptions = { ...options(signer.address), problemId: extra.problemId ?? problemId };
    const request = await prepareOpenFundingAction({ ...actionOptions, action: name, ...extra });
    const tx = await confirm(signer.sendTransaction({ to: request.address, data: request.data }));
    const result = await syncOpenFunding({ ...actionOptions, transactionHash: tx.hash, now: await chainNow() });
    return { tx, summary: result };
  };
  assert.equal((await summary(owner.address)).canCreate, true);
  const createRequest = await prepareOpenFundingAction({ ...options(owner.address), action: "create" });
  const createdPool = await owner.sendTransaction({ to: createRequest.address, data: createRequest.data });
  await createdPool.wait();
  await assert.rejects(syncOpenFunding({ ...options(owner.address), transactionHash: createdPool.hash, now: await chainNow() }),
    error => error.code === "unavailable" && /awaiting another chain confirmation/.test(error.message));
  await provider.send("evm_mine", []);
  await syncOpenFunding({ ...options(owner.address), transactionHash: createdPool.hash, now: await chainNow() });
  passed("a mined grant transaction awaits its successor block and then confirms by retrying the same hash");
  const poolAddress = (await summary(owner.address)).poolAddress;
  const pool = await ethers.getContractAt("OpenFundingPool", poolAddress);
  await confirm(token.mint(owner.address, units(150000)));
  assert.equal(await token.allowance(owner.address, poolAddress), 0n);
  const firstDeposit = await prepareOpenFundingAction({ ...options(owner.address), action: "deposit", amountBaseUnits: units(100000).toString() });
  assert.equal(firstDeposit.approvalRequired, true);
  assert.equal(lower(firstDeposit.address), lower(poolAddress));
  assert.deepEqual(firstDeposit.args, [units(100000).toString()]);
  assert.equal(await token.allowance(owner.address, poolAddress), 0n); // Preparation cannot approve or spend.
  await confirm(token.connect(owner).approve(poolAddress, ethers.MaxUint256));
  const firstDeposited = await confirm(owner.sendTransaction({ to: firstDeposit.address, data: firstDeposit.data }));
  await syncOpenFunding({ ...options(owner.address), transactionHash: firstDeposited.hash, now: await chainNow() });
  assert.equal((await summary(owner.address)).available, units(100000).toString());
  passed("owner publishes, prepares before token approval, then approves and prefunds one canonical pool with 100,000 USDC");
  await assert.rejects(prepareOpenFundingAction({ ...options(outsider.address), action: "deposit", amountBaseUnits: "1" }), { code: "permission-denied" });
  passed("other members cannot deposit into the single-owner grant pool");

  const proposals = [];
  for (const [index, signer] of [researcherA, researcherB, researcherC].entries()) {
    const record = { id: ids[index], problemId, researcherId: lower(signer.address), postingOwnerId: posting.ownerId,
      opportunityType: "open-funding", category: "quantum-adjacent", title: `Quantum grant proposal ${index + 1}`,
      summary: "Reproducible quantum-adjacent solution", methodology: "Hybrid simulation and baseline validation",
      suitability: "Fits the grant thesis", expectedOutcomes: "A working prototype", successCriteria: "Published benchmarks",
      timeline: "Eight weeks", milestones: "Baseline, prototype, validation", team: "Local test researcher",
      amount: index === 2 ? 10000 : 50000, currency: "USDC", status: "submitted", attachments: [] };
    record.fundingTerms = proposalFundingTerms({ form: { ...record, amount: String(record.amount), reviewDays: "7, 30", funderVoting: false }, currency: record.currency, config });
    const prepared = prepareStoredProposal(record, { registryConfig: config });
    const tx = await confirm(registry.connect(signer)[prepared.functionName](...prepared.args));
    record.audit = { schemaVersion: 1, chainId: 421614, status: "confirmed", transactionHash: tx.hash,
      registryAddress: config.address, blockNumber: Number((await receiptFor(tx.hash)).blockNumber) };
    await db.collection("proposals").doc(record.id).set(record);
    const escrow = await ethers.getContractAt("FundingEscrow", await factory.escrowForProposal(prepared.entityId));
    proposals.push({ record, prepared, escrow, signer });
  }
  const prospective = await summary(owner.address);
  assert.deepEqual(prospective.selections.filter(item => item.status === "none").map(item => item.proposalId).sort(), [...ids].sort());
  assert.equal(prospective.canSelect, true);
  const focused = await getOpenFundingSummary({ ...options(researcherC.address), proposalId: ids[2] });
  assert.deepEqual(focused.selections.map(item => item.proposalId), [ids[2]]);
  assert.equal(focused.selections[0].status, "none");
  await assert.rejects(prepareEscrowDeposit({ db, client, config, uid: posting.ownerId, proposalId: ids[0] }), { code: "failed-precondition" });
  passed("confirmed prospective proposals appear in owner/targeted researcher summaries and stay outside ordinary multi-funder deposits");
  for (const item of proposals.slice(0, 2)) await action(owner, "select", { proposalId: item.record.id });
  let current = await summary(owner.address);
  assert.equal(current.totalReserved, units(100000).toString());
  assert.equal(current.available, "0");
  assert.equal(current.selections.filter(item => item.status === "pending").length, 2);
  for (const item of proposals.slice(0, 2)) {
    const selection = current.selections.find(row => row.proposalId === item.record.id);
    const selectedEvents = await pool.queryFilter(pool.filters.ProposalSelected(item.prepared.entityId));
    const selectedAt = (await provider.getBlock(selectedEvents[0].blockNumber)).timestamp;
    assert.equal(BigInt(selection.acceptanceDeadline) - BigInt(selectedAt), 7n * 86400n);
  }
  await assert.rejects(prepareOpenFundingAction({ ...options(owner.address), action: "select", proposalId: ids[2] }));
  passed("two 50,000 USDC selections reserve exactly 100,000; each has seven days; oversubscription fails");
  await assert.rejects(prepareOpenFundingAction({ ...options(outsider.address), action: "accept", proposalId: ids[0] }), { code: "permission-denied" });
  for (const item of proposals.slice(0, 2)) {
    await action(item.signer, "accept", { proposalId: item.record.id });
    assert.equal(await token.balanceOf(await item.escrow.getAddress()), units(50000));
    assert.equal(await item.escrow.totalDeposited(), units(50000));
    assert.equal(await item.escrow.contributions(owner.address), units(50000));
    assert.equal(await item.escrow.ownerApproved(), true);
    assert.equal(await item.escrow.solutionApproved(), true);
    const indexed = await syncEscrowFunding({ db, client, config, uid: lower(item.signer.address), proposalId: item.record.id, now: await chainNow() });
    assert.equal(indexed.reconciliation.status, "verified");
    assert.equal(indexed.summary.totalDeposited, units(50000).toString());
  }
  current = await summary(owner.address);
  assert.equal(current.totalAllocated, units(100000).toString());
  assert.equal(current.totalReserved, "0");
  assert.equal(current.selections.filter(item => item.status === "accepted").length, 2);
  assert.equal((await db.collection("problems").doc(problemId).get()).data().acceptedProposalId, undefined);
  passed("both researchers accept; each canonical escrow receives 50,000, attributed to owner, without a posting-wide winner");

  for (const item of proposals.slice(0, 2)) {
    await confirm(item.escrow.connect(platform).release(item.prepared.entityId));
    const indexed = await syncEscrowFunding({ db, client, config, uid: lower(item.signer.address), proposalId: item.record.id, now: await chainNow() });
    assert.equal(indexed.reconciliation.status, "verified");
    assert.equal(indexed.summary.totalReleased, units(25000).toString());
    assert.equal((await db.collection("proposals").doc(item.record.id).get()).data().status, "accepted");
  }
  passed("both accepted proposals independently release their 50% upfront payments");

  await action(owner, "deposit", { amountBaseUnits: units(10000).toString() });
  await action(owner, "select", { proposalId: ids[2] });
  const third = proposals[2], offer = await pool.getOffer(third.prepared.entityId);
  await provider.send("evm_setNextBlockTimestamp", [Number(offer.acceptanceDeadline)]);
  await provider.send("evm_mine", []);
  await provider.send("evm_mine", []);
  await assert.rejects(prepareOpenFundingAction({ ...options(third.signer.address), action: "accept", proposalId: ids[2] }), { code: "failed-precondition" });
  await action(outsider, "void", { proposalId: ids[2] });
  current = await summary(owner.address);
  assert.equal(current.selections.find(item => item.proposalId === ids[2]).status, "voided");
  assert.equal(current.totalReserved, "0");
  assert.equal(current.available, units(10000).toString());
  assert.equal(await third.escrow.totalDeposited(), 0n);
  passed("at the exact seven-day boundary acceptance fails and permissionless void returns the reservation to the pool");

  await action(owner, "deposit", { amountBaseUnits: units(5000).toString() });
  current = await summary(owner.address);
  assert.equal(current.totalDeposited, units(115000).toString());
  assert.equal(current.available, units(15000).toString());
  assert.equal(await token.balanceOf(poolAddress), units(15000));
  for (const item of proposals.slice(0, 2)) {
    const evidence = ethers.id(`Completed grant prototype ${item.record.id}`);
    await confirm(item.escrow.connect(item.signer).submitMilestone(1, evidence));
    await confirm(item.escrow.connect(owner).approveMilestone(item.prepared.entityId, 1, evidence));
    await confirm(item.escrow.connect(item.signer).approveMilestone(item.prepared.entityId, 1, evidence));
    await confirm(item.escrow.connect(platform).releaseMilestone(item.prepared.entityId, 1, evidence));
    const indexed = await syncEscrowFunding({ db, client, config, uid: lower(item.signer.address), proposalId: item.record.id, now: await chainNow() });
    assert.equal(indexed.reconciliation.status, "verified");
    assert.equal(indexed.summary.totalReleased, units(50000).toString());
    assert.equal(indexed.summary.state, "Released");
    assert.equal(await token.balanceOf(item.signer.address), units(50000));
    assert.equal((await db.collection("proposals").doc(item.record.id).get()).data().status, "accepted");
  }
  assert.equal((await db.collection("problems").doc(problemId).get()).data().acceptedProposalId, undefined);
  passed("owner can top up after awards; both proposals independently complete evidence, dual approvals and final 50% payments");

  // Closing submissions must not shorten an already issued seven-day offer.
  const shortId = `short-grant-${suffix}`, shortProposalId = `short-proposal-${suffix}`;
  const shortPosting = { ...posting, id: shortId, title: "Short submission window grant", amount: 1000,
    expiresAt: firestore.Timestamp.fromMillis(Number((await client.getBlock()).timestamp + 86400n) * 1000) };
  const shortCommit = prepareOpportunityCommit({ recordId: shortId, actor: shortPosting.ownerId,
    payload: fundingOpportunityAuditPayload(shortPosting), kind: 1, expiresAt: shortPosting.expiresAt, hashScheme: 1 });
  const shortTx = await confirm(registry.connect(owner)[shortCommit.functionName](...shortCommit.args));
  shortPosting.audit = { ...posting.audit, transactionHash: shortTx.hash };
  await db.collection("problems").doc(shortId).set(shortPosting);
  await action(owner, "create", { problemId: shortId });
  const shortPoolAddress = (await summary(owner.address, shortId)).poolAddress;
  await confirm(token.connect(owner).approve(shortPoolAddress, ethers.MaxUint256));
  await action(owner, "deposit", { problemId: shortId, amountBaseUnits: units(1000).toString() });
  const shortRecord = { ...proposals[0].record, id: shortProposalId, problemId: shortId, amount: 1000, status: "submitted" };
  shortRecord.fundingTerms = proposalFundingTerms({ form: { ...shortRecord, amount: "1000", reviewDays: "7, 30", funderVoting: false }, currency: "USDC", config });
  const shortPrepared = prepareStoredProposal(shortRecord, { registryConfig: config });
  const shortProposalTx = await confirm(registry.connect(researcherA)[shortPrepared.functionName](...shortPrepared.args));
  shortRecord.audit = { ...shortRecord.audit, transactionHash: shortProposalTx.hash };
  await db.collection("proposals").doc(shortProposalId).set(shortRecord);
  await action(owner, "select", { problemId: shortId, proposalId: shortProposalId });
  await provider.send("evm_setNextBlockTimestamp", [Math.floor(shortPosting.expiresAt.toMillis() / 1000) + 1]);
  await provider.send("evm_mine", []);
  await provider.send("evm_mine", []);
  const afterClosing = await summary(researcherA.address, shortId);
  assert.equal(afterClosing.closed, true);
  assert.equal(afterClosing.selections[0].canAccept, true);
  await action(researcherA, "accept", { problemId: shortId, proposalId: shortProposalId });
  assert.equal((await summary(owner.address, shortId)).totalAllocated, units(1000).toString());
  await action(owner, "deposit", { problemId: shortId, amountBaseUnits: units(1000).toString() });
  assert.equal((await summary(owner.address, shortId)).available, units(1000).toString());
  await action(owner, "withdraw", { problemId: shortId, amountBaseUnits: units(1000).toString() });
  assert.equal((await summary(owner.address, shortId)).totalWithdrawn, units(1000).toString());
  passed("submission closing preserves the seven-day offer; owner can top up and recover only unreserved funds after closing");
  console.log(`\n${checks} local E2E checks passed (contracts + production backend services + Firestore emulator).`);
} catch (error) {
  console.error(`FAIL ${error.shortMessage ?? error.message}`);
  if (error.solidityStack) console.error(error.solidityStack);
  process.exitCode = 1;
} finally {
  await db.terminate();
  await admin.deleteApp(app);
  await connection.close();
}
