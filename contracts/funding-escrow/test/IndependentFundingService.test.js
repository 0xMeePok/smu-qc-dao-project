import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { network } from "hardhat";
import mainConfig from "../../../firebase/functions/auditRegistry.contract.json" with { type: "json" };
import { prepareStoredProposal } from "../../../firebase/functions/proposalAuditPayload.js";
import { getIndependentFundingState, prepareIndependentFundingAction, syncIndependentFunding,
  hashIndependentFundingEvidence, readIndependentFundingPortfolio } from "../../../firebase/functions/independentFunding.js";
import { memoryDb } from "../../../firebase/functions/test/memoryDb.mjs";

const requireFunctions = createRequire(new URL("../../../firebase/functions/package.json", import.meta.url));
const { createPublicClient, custom } = requireFunctions("viem");
const { Timestamp } = requireFunctions("firebase-admin/firestore");
const abi = contract => JSON.parse(contract.interface.formatJson());
const uid = signer => signer.address.toLowerCase();

async function fixture() {
  const connection = await network.create({ override: { chainId: 421614 } });
  const { ethers } = connection;
  const [admin, researcher, alice, bob] = await ethers.getSigners();
  const token = await ethers.deployContract("EscrowTestToken", [6]);
  const tokenAddress = await token.getAddress();
  const registry = await ethers.deployContract("EscrowAuditRegistry", [admin.address]);
  const policy = await ethers.deployContract("FundingEscrowFactory", [admin.address, admin.address, [tokenAddress], 25, await registry.getAddress()]);
  await registry.setFundingFactory(await policy.getAddress());
  const factory = await ethers.deployContract("IndependentFundingFactory", [await policy.getAddress()]);
  const escrowInterface = await ethers.getContractFactory("IndependentFundingEscrow");
  const config = { ...mainConfig, address: await registry.getAddress(), abi: abi(registry), chainId: 421614,
    escrow: { ...mainConfig.escrow, factoryAddress: await policy.getAddress(), factoryAbi: abi(policy),
      tokens: [{ address: tokenAddress, symbol: "USDC", decimals: 6 }] } };
  config.independentFunding = { enabled: true, chainId: 421614, registryAddress: config.address,
    tokenRegistryAddress: config.escrow.factoryAddress, factoryAddress: await factory.getAddress(),
    factoryAbi: abi(factory), escrowAbi: abi(escrowInterface), reviewDays: 7, tokens: config.escrow.tokens };
  const record = { id: "independent-service-flow", proposalKind: "independent", researcherId: uid(researcher),
    title: "Independent routing research", summary: "Compare routing methods on synthetic data", methodology: "Hybrid annealing",
    addressedProblems: "Last-mile delivery routing", category: "quantum-adjacent", maturity: "pilot", team: "Research team",
    amount: 2, currency: "USDC", status: "submitted", attachments: [],
    expiresAt: Timestamp.fromMillis(((await ethers.provider.getBlock("latest")).timestamp + 30 * 86400) * 1000),
    fundingTerms: { reviewWindows: [604800, 604800] } };
  const expected = prepareStoredProposal(record, { registryConfig: config });
  const anchor = await registry.connect(researcher).commitOpportunity(...expected.args);
  await anchor.wait();
  record.audit = { schemaVersion: 2, chainId: 421614, status: "pending", transactionHash: anchor.hash,
    entityId: expected.entityId, contentHash: expected.contentHash };
  const db = memoryDb({ [`proposals/${record.id}`]: record,
    ...Object.fromEntries([admin, researcher, alice, bob].map(signer => [`users/${uid(signer)}`, { role: signer === admin ? 1 : 0 }])) });
  const originalCollection = db.collection;
  db.collection = name => {
    const collection = originalCollection(name), originalDoc = collection.doc;
    collection.doc = id => { const ref = originalDoc(id); ref.collection = child => db.collection(`${ref.path}/${child}`); return ref; };
    return collection;
  };
  const client = createPublicClient({ cacheTime: 0, transport: custom({ request: ({ method, params }) => ethers.provider.send(method, params ?? []) }) });
  const mine = () => ethers.provider.send("evm_mine", []);
  await mine();
  for (const funder of [alice, bob]) await token.mint(funder.address, 5_000_000n);
  await mine();
  const options = signer => ({ db, client, config, uid: uid(signer), proposalId: record.id });
  const prepare = (signer, action, input = {}) => prepareIndependentFundingAction({ ...options(signer), action, ...input });
  const run = async (signer, action, input = {}) => {
    const prepared = await prepare(signer, action, input);
    const contract = new ethers.Contract(prepared.address, prepared.abi, signer);
    const transaction = await contract[prepared.functionName](...prepared.args);
    await transaction.wait(); await mine();
    return syncIndependentFunding({ ...options(signer), transactionHash: transaction.hash });
  };
  await run(researcher, "activate");
  const escrowAddress = await factory.escrowForListing(expected.entityId);
  const escrow = await ethers.getContractAt("IndependentFundingEscrow", escrowAddress);
  const deposit = async (funder, amount = "1") => {
    // Preparation must work before ERC20 allowance exists, as it does in the UI.
    const prepared = await prepare(funder, "deposit", { amount });
    await token.connect(funder).approve(escrowAddress, prepared.amountBaseUnits);
    return run(funder, "deposit", { amount });
  };
  return { connection, ethers, admin, researcher, alice, bob, token, registry, policy, factory, escrow,
    db, client, config, record, expected, options, prepare, run, deposit, mine };
}

describe("Independent crowdfunding: real contract and application service integration", function () {
  this.timeout(120_000);

  it("publishes with a pending receipt, funds, accepts, verifies evidence and pays on the strict majority vote", async function () {
    const c = await fixture();
    try {
      await c.deposit(c.alice);
      await c.deposit(c.bob);
      const accepted = await c.run(c.researcher, "accept");
      assert.equal(accepted.summary.totalReleased, "1000000");
      assert.equal(accepted.summary.feePaid, "2500");
      assert.equal(await c.token.balanceOf(c.researcher.address), 997500n);
      const evidence = { summary: "Research completed with reproducible routing results", url: "https://example.com/research-evidence" };
      const evidenceHash = hashIndependentFundingEvidence(evidence);
      await c.run(c.researcher, "submitEvidence", { evidence, evidenceHash });
      const tied = await c.run(c.alice, "vote", { approve: true, evidenceHash });
      assert.equal(tied.summary.state, "Accepted");
      assert.equal(tied.summary.totalReleased, "1000000");
      const paid = await c.run(c.bob, "vote", { approve: true, evidenceHash });
      assert.equal(paid.summary.state, "Released");
      assert.equal(paid.summary.totalReleased, "2000000");
      assert.equal(paid.summary.feePaid, "5000");
      assert.equal(paid.summary.outstandingBalance, "0");
      assert.equal(await c.token.balanceOf(c.researcher.address), 1995000n);
      assert.equal(await c.token.balanceOf(c.admin.address), 5000n);
      assert.equal(await c.registry.fundingFactory(), await c.policy.getAddress());
      const portfolio = await readIndependentFundingPortfolio(c.options(c.alice));
      assert.equal(portfolio.items.length, 1);
      assert.equal(portfolio.items[0].wallet.claimable, null);
      assert.equal(portfolio.items[0].stale, true);
    } finally { await c.connection.close(); }
  });

  it("declines full funding and refunds both contributors without any platform fee", async function () {
    const c = await fixture();
    try {
      await c.deposit(c.alice); await c.deposit(c.bob);
      const declined = await c.run(c.researcher, "decline", { reason: "Unable to commit to the research delivery schedule" });
      assert.equal(declined.summary.state, "Declined");
      await c.run(c.alice, "claimRefund");
      const refunded = await c.run(c.bob, "claimRefund");
      assert.equal(refunded.summary.state, "Refunded");
      assert.equal(refunded.summary.totalRefunded, "2000000");
      assert.equal(refunded.summary.feePaid, "0");
      assert.equal(await c.token.balanceOf(c.admin.address), 0n);
      assert.equal(await c.token.balanceOf(c.alice.address), 5000000n);
      assert.equal(await c.token.balanceOf(c.bob.address), 5000000n);
    } finally { await c.connection.close(); }
  });

  it("keeps a removed listing's unpaid half claimable after an upfront payment", async function () {
    const c = await fixture();
    try {
      await c.deposit(c.alice); await c.deposit(c.bob); await c.run(c.researcher, "accept");
      await c.escrow.adminCancel(c.ethers.id("administrator cancelled the listing")); await c.mine();
      const stored = c.db.records.get(`proposals/${c.record.id}`);
      c.db.records.set(`proposals/${c.record.id}`, { ...stored, moderationStatus: "removed", status: "moderated_removed" });
      const state = await getIndependentFundingState(c.options(c.alice));
      assert.equal(state.hidden, true); assert.equal(state.actions.deposit, false); assert.equal(state.actions.claimRefund, true);
      assert.equal(state.wallet.claimable, "500000");
      await c.run(c.alice, "claimRefund"); await c.run(c.bob, "claimRefund");
      assert.equal(await c.token.balanceOf(c.admin.address), 2500n, "Refunds must not add to the upfront payout fee");
      assert.equal(await c.token.balanceOf(c.alice.address), 4500000n);
      assert.equal(await c.token.balanceOf(c.bob.address), 4500000n);
      assert.equal(await c.escrow.outstandingBalance(), 0n);
    } finally { await c.connection.close(); }
  });

  it("lets a funder claim expired partial funding directly, with no preliminary transaction or fee", async function () {
    const c = await fixture();
    try {
      await c.deposit(c.alice);
      await c.ethers.provider.send("evm_setNextBlockTimestamp", [Number(c.record.expiresAt.seconds) + 1]);
      await c.mine(); await c.mine();
      const state = await getIndependentFundingState(c.options(c.alice));
      assert.equal(state.summary.state, "Expired");
      assert.equal(state.actions.expire, false);
      assert.equal(state.actions.claimRefund, true);
      const refunded = await c.run(c.alice, "claimRefund");
      assert.equal(refunded.summary.state, "Refunded");
      assert.equal(refunded.summary.totalRefunded, "1000000");
      assert.equal(refunded.summary.feePaid, "0");
      assert.equal(await c.token.balanceOf(c.alice.address), 5000000n);
    } finally { await c.connection.close(); }
  });
});
