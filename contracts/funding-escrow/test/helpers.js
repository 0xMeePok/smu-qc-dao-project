import { expect } from "chai";
import { network } from "hardhat";

export const State = { Open: 0n, Locked: 1n, Released: 2n, Refunded: 3n, Cancelled: 4n, Expired: 5n, Active: 6n, Voided: 7n };
export const Status = { None: 0n, Locked: 1n, RefundPending: 2n, Refundable: 3n, Refunded: 4n, Released: 5n, PartiallyReleased: 6n };
export const Behavior = { Standard: 0, FalseReturn: 1, NoReturn: 2, RecipientFee: 3, SenderFee: 4, NoMovement: 5, Reverting: 6 };

export function scopedId(c, signer, label) {
  return signer.address.toLowerCase() + c.ethers.id(label).slice(2, 26);
}
export function terms(c, changes = {}) {
  const trancheBps = changes.trancheBps ?? [10000];
  return { token: c.tokenAddress, target: c.target, funderVoting: false,
    trancheBps, reviewWindows: trancheBps.map(() => 7 * 86400),
    milestoneHashes: trancheBps.map((_, i) => c.ethers.id(`milestone-${i}`)), ...changes };
}
export async function createProposal(c, label = "proposal-2", changes = {}, signer = c.solution) {
  const id = scopedId(c, signer, label);
  return c.registry.connect(signer).commitProposalWithEscrow(id, c.postingId,
    c.ethers.id(label), c.ethers.id(`solution-${label}`), 0, terms(c, changes));
}
export async function fixture(options = {}) {
  const { decimals = 6, duration = 10 * 86400, target = 1000n, feeBps = 0 } = options;
  const connection = await network.create();
  const { ethers } = connection;
  const [platform, owner, solution, alice, bob, other, admin] = await ethers.getSigners();
  const token = await ethers.deployContract("EscrowTestToken", [decimals]);
  const tokenAddress = await token.getAddress();
  const registry = await ethers.deployContract("EscrowAuditRegistry", [admin.address]);
  const registryAddress = await registry.getAddress();
  const factory = await ethers.deployContract("FundingEscrowFactory", [admin.address, platform.address, [tokenAddress], feeBps, registryAddress]);
  await registry.connect(admin).setFundingFactory(await factory.getAddress());
  const selectionId = ethers.id("selection-1");
  const reason = ethers.id("withdrawal or invalidation evidence");
  const expiresAt = BigInt((await ethers.provider.getBlock("latest")).timestamp + duration);
  const c = { connection, ethers, platform, owner, solution, alice, bob, other, admin, token, tokenAddress,
    registry, registryAddress, factory, selectionId, reason, target, expiresAt };
  c.postingId = scopedId(c, owner, "posting-1");
  c.proposalId = scopedId(c, solution, "proposal-1");
  await registry.connect(owner).commitOpportunity(c.postingId, 0, ethers.id("posting content"), expiresAt);
  const plan = {};
  for (const key of ["trancheBps", "reviewWindows", "milestoneHashes", "funderVoting"]) {
    if (options[key] !== undefined) plan[key] = options[key];
  }
  c.creation = await createProposal(c, "proposal-1", plan);
  c.escrowAddress = await factory.escrowForProposal(c.proposalId);
  c.escrow = await ethers.getContractAt("FundingEscrow", c.escrowAddress);
  for (const signer of [alice, bob, other]) {
    const mint = target > ethers.MaxUint256 / 30n ? target / 3n : target * 10n;
    await token.mint(signer.address, mint);
    await token.connect(signer).approve(c.escrowAddress, ethers.MaxUint256);
  }
  return c;
}

export async function at(ctx, timestamp) {
  await ctx.ethers.provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
}
export async function mineAt(ctx, timestamp) {
  await at(ctx, timestamp);
  await ctx.ethers.provider.send("evm_mine", []);
}
export async function fund(ctx) {
  await ctx.escrow.connect(ctx.alice).deposit(ctx.target);
}
export async function lock(ctx) {
  await fund(ctx);
  await ctx.escrow.lockSelection(ctx.selectionId, ctx.solution.address);
}
export async function approve(ctx) {
  await lock(ctx);
  await ctx.escrow.connect(ctx.owner).approveSelection(ctx.selectionId);
  await ctx.escrow.connect(ctx.solution).approveSelection(ctx.selectionId);
}
export async function assertAccounting(ctx) {
  const deposited = await ctx.escrow.totalDeposited();
  const refunded = await ctx.escrow.totalRefunded();
  const released = await ctx.escrow.totalReleased();
  const outstanding = await ctx.escrow.outstandingBalance();
  expect(deposited).to.equal(refunded + released + outstanding);
  expect(await ctx.token.balanceOf(ctx.escrowAddress)).to.be.at.least(outstanding);
}
