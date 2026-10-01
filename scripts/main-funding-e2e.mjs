/**
 * Local integration test: real main funding contracts + production backend services
 * + Firestore emulator. No .env, deployed addresses, live RPC, or existing wallet keys are used.
 *
 * Start Firestore with a demo project, compile funding-escrow, then run:
 * FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/main-funding-e2e.mjs
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
const projectId = process.env.MAIN_FUNDING_E2E_PROJECT ?? `demo-main-funding-e2e-${suffix}`;
if (!/^demo-[a-z0-9-]+$/.test(projectId)) throw new Error("Use a demo- Firebase project for this local test.");

const [{ createHardhatRuntimeEnvironment }, { default: hardhatEthers }, admin, firestore] = await Promise.all([
  loadContract("hardhat/hre"), loadContract("@nomicfoundation/hardhat-ethers"),
  loadBackend("firebase-admin/app"), loadBackend("firebase-admin/firestore"),
]);
const { syncEscrowFunding, prepareEscrowDeposit, startEscrowSettlement, sweepEscrowFunding, resumePlatformTransaction } = await import("../firebase/functions/escrowFunding.js");
const { prepareOpportunityCommit } = await import("../firebase/functions/auditCanonical.js");
const { postingAuditPayload } = await import("../firebase/functions/opportunityAuditPayload.js");
const { prepareStoredProposal } = await import("../firebase/functions/proposalAuditPayload.js");
const { proposalFundingTerms } = await import("../firebase/functions/escrowProposalTerms.js");

// A separate HRE prevents loading the repository's deployment configuration/.env.
const hre = await createHardhatRuntimeEnvironment({
  plugins: [hardhatEthers],
  paths: { artifacts: path.join(contractRoot, "artifacts"), cache: path.join("/tmp", "qcdao-main-funding-e2e-cache") },
  networks: { main: { type: "edr-simulated", chainType: "generic", chainId: 421614 } },
}, {}, contractRoot);
const connection = await hre.network.create("main");
const { ethers } = connection;
const [, owner, researcherA, researcherB, researcherC, outsider, adminSigner, funderA, funderB, funderC] = await ethers.getSigners();
const provider = ethers.provider;
const app = admin.initializeApp({ projectId }, `main-funding-e2e-${Date.now()}`);
const db = firestore.getFirestore(app);
const platform = ethers.Wallet.createRandom().connect(provider);
const units = dollars => BigInt(dollars) * 1_000_000n;
const lower = address => address.toLowerCase();
const results = [];
let checks = 0;
const passed = label => { checks++; results.push(label); console.log(`PASS ${label}`); };

const receiptFor = async hash => {
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt) throw new Error(`Local transaction ${hash} has not been mined.`);
  return { status: receipt.status === 1 ? "success" : "reverted", transactionHash: receipt.hash,
    to: receipt.to, from: receipt.from, blockHash: receipt.blockHash, blockNumber: BigInt(receipt.blockNumber),
    logs: receipt.logs.map(log => ({ address: log.address, topics: log.topics, data: log.data,
      logIndex: log.index, transactionHash: receipt.hash, blockHash: receipt.blockHash, blockNumber: BigInt(receipt.blockNumber) })) };
};
const client = {
  getTransactionCount: async ({ address, blockTag, blockNumber }) => Number(await provider.send("eth_getTransactionCount", [address, blockNumber === undefined ? blockTag ?? "latest" : ethers.toQuantity(blockNumber)])),
  sendRawTransaction: ({ serializedTransaction }) => provider.send("eth_sendRawTransaction", [serializedTransaction]),
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
    return new ethers.Contract(address, abi, provider)[functionName].staticCall(...args, { from: typeof account === "string" ? account : account.address });
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

const wallet = { account: { address: platform.address }, chain: { id: 421614 },
  prepareTransactionRequest: ({ to, data, nonce }) => platform.populateTransaction({ to, data, nonce, chainId: 421614 }),
  signTransaction: request => platform.signTransaction(request),
};
const getWallet = async () => wallet;

try {
  await confirm(adminSigner.sendTransaction({ to: platform.address, value: ethers.parseEther("100") }));
  const token = await ethers.deployContract("EscrowTestToken", [6]);
  const registry = await ethers.deployContract("EscrowAuditRegistry", [adminSigner.address]);
  const factory = await ethers.deployContract("FundingEscrowFactory", [adminSigner.address, platform.address,
    [await token.getAddress()], 0, await registry.getAddress()]);
  await confirm(registry.connect(adminSigner).setFundingFactory(await factory.getAddress()));
  const config = { contractName: "EscrowAuditRegistry", chainId: 421614, entityIdScheme: 2,
    address: lower(await registry.getAddress()), abi: JSON.parse(registry.interface.formatJson()),
    escrow: { factoryAddress: lower(await factory.getAddress()), factoryAbi: JSON.parse(factory.interface.formatJson()),
      escrowAbi: (await hre.artifacts.readArtifact("FundingEscrow")).abi,
      openFundingPoolAbi: (await hre.artifacts.readArtifact("OpenFundingPool")).abi,
      tokens: [{ address: lower(await token.getAddress()), symbol: "USDC", decimals: 6 }] } };
  await Promise.all([owner, researcherA, researcherB, researcherC, outsider, funderA, funderB, funderC].map(signer =>
    db.collection("users").doc(lower(signer.address)).set({ role: 0, suspended: false, onboardingComplete: true })));
  for (const funder of [funderA, funderB, funderC]) await confirm(token.mint(funder.address, units(1000000)));
  const service = async (item, extra = {}) => ({ db, client, config, getWallet, proposalId: item.record.id,
    now: await chainNow(), ...extra });
  const sync = async (item, extra = {}) => syncEscrowFunding(await service(item, extra));
  const pump = async (item, rounds = 3) => {
    let result;
    for (let i = 0; i < rounds; i++) {
      await provider.send("evm_mine", []);
      await resumePlatformTransaction({ db, client, config, now: await chainNow() });
      result = await sync(item);
    }
    return result;
  };
  const advanceTo = async timestamp => {
    await provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
    await provider.send("evm_mine", []);
    await provider.send("evm_mine", []);
  };
  let sequence = 0;
  const posting = async (label, duration = 90 * 86400) => {
    const id = `main-${label}-${suffix}-${sequence++}`;
    const expiresAt = firestore.Timestamp.fromMillis(Number((await client.getBlock()).timestamp + BigInt(duration)) * 1000);
    const record = { id, ownerId: lower(owner.address), opportunityType: "business-problem", organisation: "Local E2E",
      title: `Business problem ${label}`, businessContext: "Improve resource scheduling", summary: "Compare quantum scheduling solutions",
      currentApproach: "Classical baseline", currentLimitations: "Large search space", expectedOutcome: "Reproducible improvement",
      successCriteria: "Benchmarks", dataAvailability: "Synthetic dataset", categories: ["quantum-adjacent"],
      amount: 100000, currency: "USDC", expiresAt, status: "submitted", attachments: [] };
    const prepared = prepareOpportunityCommit({ recordId: id, actor: record.ownerId,
      payload: postingAuditPayload(record), kind: 0, expiresAt, hashScheme: 1 });
    const tx = await confirm(registry.connect(owner)[prepared.functionName](...prepared.args));
    record.audit = { schemaVersion: 1, chainId: 421614, status: "confirmed", transactionHash: tx.hash,
      registryAddress: config.address, blockNumber: Number((await receiptFor(tx.hash)).blockNumber) };
    await db.collection("problems").doc(id).set(record);
    return { record, prepared };
  };
  const proposal = async (parent, signer, voting = false) => {
    const record = { id: `proposal-${suffix}-${sequence++}`, problemId: parent.record.id,
      researcherId: lower(signer.address), postingOwnerId: parent.record.ownerId, opportunityType: "business-problem",
      category: "quantum-adjacent", title: "Quantum scheduling solution", summary: "Reproducible scheduling prototype",
      methodology: "Hybrid simulation", suitability: "Matches the business problem", expectedOutcomes: "Working prototype",
      successCriteria: "Benchmark improvement", timeline: "Eight weeks", milestones: "Prototype and validation",
      team: "Local researcher", amount: 100000, currency: "USDC", status: "submitted", attachments: [] };
    record.fundingTerms = proposalFundingTerms({ form: { ...record, amount: String(record.amount), reviewDays: "3, 30", funderVoting: voting },
      currency: record.currency, config });
    const prepared = prepareStoredProposal(record, { registryConfig: config });
    const tx = await confirm(registry.connect(signer)[prepared.functionName](...prepared.args));
    record.audit = { schemaVersion: 1, chainId: 421614, status: "confirmed", transactionHash: tx.hash,
      registryAddress: config.address, blockNumber: Number((await receiptFor(tx.hash)).blockNumber) };
    await db.collection("proposals").doc(record.id).set(record);
    const escrow = await ethers.getContractAt("FundingEscrow", await factory.escrowForProposal(prepared.entityId));
    const item = { record, prepared, escrow, signer, parent };
    await sync(item);
    return item;
  };
  const deposit = async (item, signer, dollars) => {
    const request = await prepareEscrowDeposit(await service(item, { uid: lower(signer.address) }));
    assert.equal(lower(request.escrowAddress), lower(await item.escrow.getAddress()));
    await confirm(token.connect(signer).approve(await item.escrow.getAddress(), units(dollars)));
    const tx = await confirm(item.escrow.connect(signer).deposit(units(dollars)));
    const result = await sync(item, { uid: lower(signer.address), transactionHash: tx.hash });
    assert.equal(result.reconciliation.status, "verified");
    return result;
  };
  const select = async item => {
    await startEscrowSettlement(await service(item, { uid: lower(owner.address) }));
    await pump(item);
    assert.equal(await item.escrow.state(), 1n);
    const events = await item.escrow.queryFilter(item.escrow.filters.SelectionLocked());
    const selectedAt = (await provider.getBlock(events.at(-1).blockNumber)).timestamp;
    assert.equal(await item.escrow.approvalDeadline(), BigInt(selectedAt) + 604800n);
    return item.escrow.selectionId();
  };
  const approve = async (item, signer) => confirm(item.escrow.connect(signer).approveSelection(await item.escrow.selectionId()));
  const parentData = async item => (await db.collection("problems").doc(item.record.problemId).get()).data();
  const upfront = async item => {
    await approve(item, owner);
    await pump(item);
    assert.equal(await item.escrow.totalReleased(), 0n);
    assert.equal((await parentData(item)).acceptedProposalId, undefined);
    await approve(item, item.signer);
    await pump(item);
    assert.equal(await item.escrow.totalReleased(), units(50000));
    assert.equal(await item.escrow.state(), 6n);
    assert.equal((await parentData(item)).acceptedProposalId, item.record.id);
  };
  const submit = async item => {
    const evidence = ethers.id(`qcdao-main-e2e-evidence:${item.record.id}`);
    await confirm(item.escrow.connect(item.signer).submitMilestone(1, evidence));
    return evidence;
  };
  const approveFinal = async (item, signer, evidence) =>
    confirm(item.escrow.connect(signer).approveMilestone(await item.escrow.selectionId(), 1, evidence));

  const business = await posting("owners");
  const winner = await proposal(business, researcherA);
  const sibling = await proposal(business, researcherB);
  await deposit(winner, funderA, 50000);
  await deposit(winner, funderB, 50000);
  await deposit(sibling, funderC, 10000);
  await assert.rejects(startEscrowSettlement(await service(winner, { uid: lower(researcherA.address) })), { code: "permission-denied" });
  passed("business problem and proposals publish canonical receipts; only the posting owner selects a fully funded proposal");
  await select(winner);
  assert.equal(await registry.pendingProposalForPosting(business.prepared.entityId), winner.prepared.entityId);
  await assert.rejects(prepareEscrowDeposit(await service(sibling, { uid: lower(funderC.address) })), { code: "failed-precondition" });
  await assert.rejects(sibling.escrow.connect(funderC).deposit(1));
  assert.equal(await registry.isFundingInvalidated(sibling.prepared.entityId, await sibling.escrow.getAddress()), false);
  assert.equal(await sibling.escrow.refundsEnabled(), false);
  passed("selection starts exactly seven days and temporarily blocks every sibling without prematurely invalidating their deposits");
  await upfront(winner);
  assert.equal(await token.balanceOf(researcherA.address), units(50000));
  assert.equal(await registry.pendingProposalForPosting(business.prepared.entityId), ethers.ZeroHash);
  await pump(sibling);
  assert.equal(await sibling.escrow.refundsEnabled(), true);
  const beforeSiblingRefund = await token.balanceOf(funderC.address);
  const siblingRefund = await confirm(sibling.escrow.connect(funderC).claimRefund());
  await sync(sibling, { transactionHash: siblingRefund.hash });
  assert.equal(await token.balanceOf(funderC.address) - beforeSiblingRefund, units(10000));
  await assert.rejects(prepareEscrowDeposit(await service(sibling, { uid: lower(funderC.address) })), { code: "failed-precondition" });
  passed("dual approval releases exactly 50%, commits the single winner, and refunds losing proposals in full");
  const evidence = await submit(winner);
  await approveFinal(winner, owner, evidence);
  await pump(winner);
  assert.equal(await winner.escrow.totalReleased(), units(50000));
  await approveFinal(winner, researcherA, evidence);
  await pump(winner);
  assert.equal(await winner.escrow.totalReleased(), units(100000));
  assert.equal(await winner.escrow.state(), 2n);
  assert.equal(await token.balanceOf(researcherA.address), units(100000));
  passed("owners-only completion requires submitted evidence and both owners before the remaining 50% is released");

  const voting = await proposal(await posting("majority"), researcherC, true);
  await deposit(voting, funderA, 50000);
  await deposit(voting, funderB, 30000);
  await deposit(voting, funderC, 20000);
  await select(voting);
  await upfront(voting);
  const voteEvidence = await submit(voting);
  await approveFinal(voting, owner, voteEvidence);
  await approveFinal(voting, researcherC, voteEvidence);
  await confirm(voting.escrow.connect(funderA).voteMilestone(1, voteEvidence, true));
  await pump(voting);
  assert.equal(await voting.escrow.yesWeight(), units(50000));
  assert.equal(await voting.escrow.totalReleased(), units(50000));
  await confirm(voting.escrow.connect(funderB).voteMilestone(1, voteEvidence, true));
  await pump(voting);
  assert.equal(await voting.escrow.totalReleased(), units(100000));
  passed("funder-voting completion also requires both owners; a 50% tie blocks payment and an 80% weighted majority releases the balance");

  for (const rejectingSigner of [owner, researcherA]) {
    const parent = await posting(`rejected-${rejectingSigner === owner ? "owner" : "researcher"}`);
    const selected = await proposal(parent, researcherA);
    const alternative = await proposal(parent, researcherB);
    await deposit(selected, funderA, 60000);
    await deposit(selected, funderB, 40000);
    await deposit(alternative, funderC, 10000);
    const selectionId = await select(selected);
    await assert.rejects(selected.escrow.connect(outsider).rejectSelection(selectionId, ethers.id("Unauthorized rejection")));
    const tx = await confirm(selected.escrow.connect(rejectingSigner).rejectSelection(selectionId, ethers.id("A revised solution is needed")));
    await sync(selected, { transactionHash: tx.hash });
    assert.equal(await selected.escrow.state(), 4n);
    assert.equal(await selected.escrow.refundPool(), units(100000));
    assert.equal((await parentData(selected)).escrowSelection, null);
    assert.equal(await registry.pendingProposalForPosting(parent.prepared.entityId), ethers.ZeroHash);
    for (const [signer, contribution] of [[funderB, 40000], [funderA, 60000]]) {
      const before = await token.balanceOf(signer.address);
      const refund = await confirm(selected.escrow.connect(signer).claimRefund());
      await sync(selected, { transactionHash: refund.hash });
      assert.equal(await token.balanceOf(signer.address) - before, units(contribution));
    }
    await deposit(alternative, funderC, 10000);
    assert.equal(await alternative.escrow.totalDeposited(), units(20000));
    passed(`${rejectingSigner === owner ? "problem owner" : "proposal owner"} rejection immediately refunds all selected deposits and reopens sibling funding`);
  }

  const timeoutParent = await posting("timeout");
  const timeout = await proposal(timeoutParent, researcherA);
  const reopened = await proposal(timeoutParent, researcherB);
  await deposit(timeout, funderA, 100000);
  await select(timeout);
  const deadline = await timeout.escrow.approvalDeadline();
  await advanceTo(deadline);
  await assert.rejects(timeout.escrow.connect(owner).approveSelection(await timeout.escrow.selectionId()));
  await sweepEscrowFunding({ db, client, config, getWallet, now: await chainNow() });
  await provider.send("evm_mine", []);
  await sweepEscrowFunding({ db, client, config, getWallet, now: await chainNow() });
  await pump(timeout);
  assert.equal(await timeout.escrow.state(), 5n);
  assert.equal(await timeout.escrow.refundPool(), units(100000));
  assert.equal((await parentData(timeout)).escrowSelection, null);
  await deposit(reopened, funderB, 10000);
  const beforeTimeoutRefund = await token.balanceOf(funderA.address);
  await confirm(timeout.escrow.connect(funderA).claimRefund());
  assert.equal(await token.balanceOf(funderA.address) - beforeTimeoutRefund, units(100000));
  passed("the backend scheduler expires an unapproved selection at seven days, clears its lock, and enables full refunds and sibling funding");

  const shortParent = await posting("short-posting", 86400);
  const short = await proposal(shortParent, researcherB);
  await deposit(short, funderB, 100000);
  await select(short);
  assert.ok(await short.escrow.approvalDeadline() > await short.escrow.expiresAt());
  await advanceTo(await short.escrow.expiresAt() + 1n);
  await upfront(short);
  passed("the full seven-day handshake remains usable when the posting closes sooner");

  console.log(JSON.stringify({ status: "passed", checks, results, projectId, chainId: 421614,
    registry: config.address, factory: config.escrow.factoryAddress,
    scope: "Isolated EVM, Firestore emulator, canonical receipts, production settlement worker, signed durable outbox; no live deployment" }, null, 2));
} finally {
  await db.terminate();
  await admin.deleteApp(app);
  await connection.close();
}
