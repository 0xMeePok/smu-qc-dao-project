import { expect } from "chai";
import { network } from "hardhat";
import { scopedId, terms, mineAt, Behavior } from "./helpers.js";

const S = { Open: 0n, Accepted: 1n, Released: 2n, Declined: 3n, Expired: 4n, Cancelled: 5n, Refunded: 6n };
async function fixture({ decimals = 0, target = 100n, feeBps = 0, reviewDays = 30, duration = 2 * 86400, tokenName = "EscrowTestToken" } = {}) {
  const connection = await network.create({ override: { chainId: 421614 } });
  const { ethers } = connection;
  const [platform, owner, solution, alice, bob, other, admin] = await ethers.getSigners();
  const token = await ethers.deployContract(tokenName, [decimals]);
  const tokenAddress = await token.getAddress();
  const registry = await ethers.deployContract("EscrowAuditRegistry", [admin.address]);
  const registryAddress = await registry.getAddress();
  const factory = await ethers.deployContract("FundingEscrowFactory", [admin.address, platform.address, [tokenAddress], feeBps, registryAddress]);
  await registry.connect(admin).setFundingFactory(await factory.getAddress());
  const independentFactory = await ethers.deployContract("IndependentFundingFactory", [await factory.getAddress()]);
  const expiresAt = BigInt((await ethers.provider.getBlock("latest")).timestamp + duration);
  const c = { connection, ethers, platform, owner, solution, alice, bob, other, admin, token, tokenAddress,
    registry, registryAddress, factory, independentFactory, target, expiresAt, reviewDays };
  c.postingId = scopedId(c, owner, "existing-business-problem");
  c.proposalId = scopedId(c, solution, "existing-main-proposal");
  await registry.connect(owner).commitOpportunity(c.postingId, 0, ethers.id("existing problem"), expiresAt);
  await registry.connect(solution).commitProposalWithEscrow(c.proposalId, c.postingId, ethers.id("main proposal"), ethers.id("main solution"), 0, terms(c));
  c.mainEscrow = await ethers.getContractAt("FundingEscrow", await factory.escrowForProposal(c.proposalId));
  c.listingId = scopedId(c, solution, "independent-listing");
  c.contentHash = ethers.id("independent funding purpose");
  await registry.connect(solution).commitOpportunity(c.listingId, 2, c.contentHash, expiresAt);
  c.termsHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "address", "address", "uint256", "uint64", "uint32"], [c.listingId, solution.address, tokenAddress, target, expiresAt, reviewDays]));
  await independentFactory.connect(solution).createEscrow(c.listingId, tokenAddress, target, reviewDays, c.termsHash);
  c.escrowAddress = await independentFactory.escrowForListing(c.listingId);
  c.escrow = await ethers.getContractAt("IndependentFundingEscrow", c.escrowAddress);
  c.reason = ethers.id("decline or cancellation explanation");
  c.evidence = ethers.id("verified completion evidence");
  for (const funder of [alice, bob, other, solution]) {
    await token.mint(funder.address, target * 10n);
    await token.connect(funder).approve(c.escrowAddress, ethers.MaxUint256);
  }
  return c;
}
async function fund(c, weights = [60n, 20n, 20n]) {
  for (const [i, amount] of weights.entries()) if (amount) await c.escrow.connect([c.alice, c.bob, c.other][i]).deposit(amount);
}
async function accept(c, weights) { await fund(c, weights); await c.escrow.connect(c.solution).acceptFunding(); }
async function evidence(c) { await c.escrow.connect(c.solution).submitEvidence(c.evidence); }
async function accounting(c) {
  expect(await c.escrow.totalDeposited()).to.equal(await c.escrow.totalReleased() + await c.escrow.totalRefunded() + await c.escrow.outstandingBalance());
  expect(await c.token.balanceOf(c.escrowAddress)).to.be.at.least(await c.escrow.outstandingBalance());
}

describe("Independent crowdfunding, isolated from existing workflows", function () {
  it("leaves main factory/registry wiring and proposal custody functional", async function () {
    const c = await fixture();
    await accept(c);
    expect(await c.registry.fundingFactory()).to.equal(await c.factory.getAddress());
    expect(await c.factory.escrowForProposal(c.proposalId)).to.equal(await c.mainEscrow.getAddress());
    expect(await c.factory.escrowForProposal(c.listingId)).to.equal(c.ethers.ZeroAddress);
    expect(await c.registry.proposalEscrow(c.listingId)).to.equal(c.ethers.ZeroAddress);
    expect(await c.registry.acceptedProposalForPosting(c.postingId)).to.equal(c.ethers.ZeroHash);
    await c.token.connect(c.alice).approve(await c.mainEscrow.getAddress(), c.target);
    await c.mainEscrow.connect(c.alice).deposit(c.target);
    const selection = c.ethers.id("main selection");
    await c.mainEscrow.connect(c.platform).lockSelection(selection, c.solution.address);
    await c.mainEscrow.connect(c.owner).approveSelection(selection);
    await c.mainEscrow.connect(c.solution).approveSelection(selection);
    await c.mainEscrow.connect(c.platform).release(selection);
    expect(await c.mainEscrow.totalReleased()).to.equal(c.target);
    expect(await c.escrow.totalReleased()).to.equal(c.target / 2n);
    await accounting(c);
  });

  it("allows only the kind-2 author to activate exactly one correctly bound escrow", async function () {
    const c = await fixture();
    const args = [c.listingId, c.tokenAddress, c.target, c.reviewDays, c.termsHash];
    await expect(c.independentFactory.connect(c.alice).createEscrow(...args)).to.be.revertedWithCustomError(c.independentFactory, "AccessDenied");
    await expect(c.independentFactory.connect(c.solution).createEscrow(...args)).to.be.revertedWithCustomError(c.independentFactory, "EscrowAlreadyExists");
    await expect(c.independentFactory.connect(c.owner).createEscrow(c.postingId, c.tokenAddress, c.target, 30, c.termsHash)).to.be.revertedWithCustomError(c.independentFactory, "InvalidInput");
    const id = scopedId(c, c.solution, "new-independent");
    await c.registry.connect(c.solution).commitOpportunity(id, 2, c.contentHash, c.expiresAt);
    for (const [target, days] of [[0n, 30], [1n, 30], [100n, 0], [100n, 366]]) {
      await expect(c.independentFactory.connect(c.solution).createEscrow(id, c.tokenAddress, target, days, c.termsHash)).to.be.revertedWithCustomError(c.independentFactory, "InvalidInput");
    }
    await expect(c.independentFactory.connect(c.solution).createEscrow(id, c.tokenAddress, c.target, 30, c.ethers.ZeroHash)).to.be.revertedWithCustomError(c.independentFactory, "InvalidInput");
    await expect(c.independentFactory.connect(c.solution).createEscrow(id, c.alice.address, c.target, 30, c.termsHash)).to.be.revertedWithCustomError(c.independentFactory, "UnsupportedToken");
  });

  it("accepts multiple deposits/topups, caps the target, and excludes author self-funding", async function () {
    const c = await fixture();
    await c.escrow.connect(c.alice).deposit(20n);
    await c.escrow.connect(c.bob).deposit(20n);
    await c.escrow.connect(c.alice).deposit(60n);
    expect(await c.escrow.contributions(c.alice.address)).to.equal(80n);
    expect(await c.escrow.funderCount()).to.equal(2n);
    const snapshot = await c.escrow.getState(c.solution.address);
    expect(snapshot.canAccept).to.equal(true);
    expect(snapshot.depositsOpen).to.equal(false);
    expect(snapshot.factory).to.equal(await c.independentFactory.getAddress());
    expect(snapshot.listingContentHash).to.equal(c.contentHash);
    await expect(c.escrow.connect(c.other).deposit(1n)).to.be.revertedWithCustomError(c.escrow, "FundingTargetExceeded").withArgs(0n);
    await expect(c.escrow.connect(c.solution).deposit(1n)).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    await expect(c.escrow.connect(c.other).deposit(0n)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    await accounting(c);
  });

  it("requires the author, full funding and an open listing for acceptance/decline", async function () {
    const c = await fixture();
    await c.escrow.connect(c.alice).deposit(99n);
    await expect(c.escrow.connect(c.solution).acceptFunding()).to.be.revertedWithCustomError(c.escrow, "FundingIncomplete");
    await expect(c.escrow.connect(c.solution).declineFunding(c.reason)).to.be.revertedWithCustomError(c.escrow, "FundingIncomplete");
    await c.escrow.connect(c.bob).deposit(1n);
    await expect(c.escrow.connect(c.alice).acceptFunding()).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    await expect(c.escrow.connect(c.solution).declineFunding(c.ethers.ZeroHash)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    await mineAt(c, c.expiresAt);
    await expect(c.escrow.connect(c.solution).acceptFunding()).to.be.revertedWithCustomError(c.escrow, "WindowClosed");
    expect((await c.escrow.getState(c.alice.address)).claimable).to.equal(99n);
  });

  it("pays half immediately and automatically pays the rest for one 60% voter", async function () {
    const c = await fixture();
    const before = await c.token.balanceOf(c.solution.address);
    await accept(c);
    expect(await c.token.balanceOf(c.solution.address)).to.equal(before + 50n);
    expect(await c.escrow.state()).to.equal(S.Accepted);
    const receiptBlock = await c.ethers.provider.getBlock("latest");
    expect(await c.escrow.completionDeadline()).to.equal(BigInt(receiptBlock.timestamp + 30 * 86400));
    await evidence(c);
    await expect(c.escrow.connect(c.alice).voteCompletion(1n, c.evidence, true)).to.emit(c.escrow, "TrancheReleased").withArgs(1, 50n, 0n, 50n);
    expect(await c.escrow.state()).to.equal(S.Released);
    expect(await c.token.balanceOf(c.solution.address)).to.equal(before + 100n);
    expect(await c.escrow.totalReleased()).to.equal(100n);
    await expect(c.escrow.releaseCompletion()).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await accounting(c);
  });

  it("uses all deposits as denominator: a 50% tie cannot release despite other voters abstaining", async function () {
    const c = await fixture(); await accept(c, [50n, 30n, 20n]); await evidence(c);
    await c.escrow.connect(c.alice).voteCompletion(1n, c.evidence, true);
    expect(await c.escrow.state()).to.equal(S.Accepted);
    await expect(c.escrow.releaseCompletion()).to.be.revertedWithCustomError(c.escrow, "FunderMajorityRequired");
    await c.escrow.connect(c.bob).voteCompletion(1n, c.evidence, false);
    expect(await c.escrow.state()).to.equal(S.Accepted);
    await c.escrow.connect(c.other).voteCompletion(1n, c.evidence, true);
    expect(await c.escrow.state()).to.equal(S.Released);
    expect(await c.escrow.yesWeight()).to.equal(70n);
    expect(await c.escrow.noWeight()).to.equal(30n);
  });

  it("invalidates old evidence votes and rejects duplicates, stale votes and non-funders", async function () {
    const c = await fixture(); await accept(c, [40n, 30n, 30n]); await evidence(c);
    await c.escrow.connect(c.alice).voteCompletion(1n, c.evidence, true);
    await expect(c.escrow.connect(c.alice).voteCompletion(1n, c.evidence, true)).to.be.revertedWithCustomError(c.escrow, "AlreadyVoted");
    await expect(c.escrow.connect(c.owner).voteCompletion(1n, c.evidence, true)).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    await expect(c.escrow.connect(c.alice).submitEvidence(c.ethers.id("outsider"))).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    const revised = c.ethers.id("revised completion");
    await c.escrow.connect(c.solution).submitEvidence(revised);
    expect(await c.escrow.yesWeight()).to.equal(0n);
    expect((await c.escrow.getState(c.alice.address)).hasVoted).to.equal(false);
    await expect(c.escrow.connect(c.bob).voteCompletion(1n, c.evidence, true)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    await expect(c.escrow.connect(c.solution).submitEvidence(c.evidence)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    await expect(c.escrow.connect(c.solution).submitEvidence(c.ethers.ZeroHash)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    await c.escrow.connect(c.bob).voteCompletion(2n, revised, true);
    expect(await c.escrow.state()).to.equal(S.Accepted);
    await c.escrow.connect(c.other).voteCompletion(2n, revised, true);
    expect(await c.escrow.state()).to.equal(S.Released);
  });

  it("uses cumulative payout-only fees for odd amounts (first fee0, final fee1)", async function () {
    const c = await fixture({ target: 3n, feeBps: 3334 });
    const authorBefore = await c.token.balanceOf(c.solution.address), feeBefore = await c.token.balanceOf(c.admin.address);
    await accept(c, [2n, 1n, 0n]);
    expect(await c.escrow.totalReleased()).to.equal(1n);
    expect(await c.escrow.feePaid()).to.equal(0n);
    await evidence(c); await c.escrow.connect(c.alice).voteCompletion(1n, c.evidence, true);
    expect(await c.escrow.totalReleased()).to.equal(3n);
    expect(await c.escrow.feePaid()).to.equal(1n);
    expect(await c.token.balanceOf(c.solution.address)).to.equal(authorBefore + 2n);
    expect(await c.token.balanceOf(c.admin.address)).to.equal(feeBefore + 1n);
    await accounting(c);
  });

  it("decline returns every deposited unit, without any platform fee", async function () {
    const c = await fixture({ feeBps: 2500 }); await fund(c);
    await c.escrow.connect(c.solution).declineFunding(c.reason);
    expect((await c.escrow.getState(c.alice.address)).claimable).to.equal(60n);
    for (const funder of [c.bob, c.alice, c.other]) await c.escrow.connect(funder).claimRefund();
    expect(await c.escrow.totalRefunded()).to.equal(100n);
    expect(await c.escrow.feePaid()).to.equal(0n);
    expect(await c.token.balanceOf(c.admin.address)).to.equal(0n);
    expect(await c.escrow.state()).to.equal(S.Refunded);
    await expect(c.escrow.connect(c.alice).claimRefund()).to.be.revertedWithCustomError(c.escrow, "NothingToRefund");
    await accounting(c);
  });

  it("makes partial and fully funded unaccepted listings pull-refundable exactly at expiry", async function () {
    for (const amount of [40n, 100n]) {
      const c = await fixture({ feeBps: 1000 }); await c.escrow.connect(c.alice).deposit(amount);
      await expect(c.escrow.expire()).to.be.revertedWithCustomError(c.escrow, "WindowStillOpen");
      await mineAt(c, c.expiresAt);
      const snapshot = await c.escrow.getState(c.alice.address);
      expect(snapshot.state).to.equal(S.Expired);
      expect(snapshot.refundsEnabled).to.equal(true);
      expect(snapshot.claimable).to.equal(amount);
      await c.escrow.connect(c.alice).claimRefund();
      expect(await c.escrow.totalRefunded()).to.equal(amount);
      expect(await c.escrow.feePaid()).to.equal(0n);
      await accounting(c);
    }
  });

  it("allows completion after the original listing expiry, within the accepted completion period", async function () {
    const c = await fixture(); await accept(c); await mineAt(c, c.expiresAt + 1n);
    expect((await c.escrow.getState(c.solution.address)).canSubmitEvidence).to.equal(true);
    await evidence(c); await c.escrow.connect(c.alice).voteCompletion(1n, c.evidence, true);
    expect(await c.escrow.state()).to.equal(S.Released);
  });

  it("missed completion returns only the remaining half, with no extra refund fee", async function () {
    const c = await fixture({ feeBps: 2500 }); await accept(c); await evidence(c);
    const feePaid = await c.escrow.feePaid(), feeBalance = await c.token.balanceOf(c.admin.address);
    await mineAt(c, await c.escrow.completionDeadline());
    await expect(c.escrow.connect(c.alice).voteCompletion(1n, c.evidence, true)).to.be.revertedWithCustomError(c.escrow, "WindowClosed");
    expect((await c.escrow.getState(c.alice.address)).claimable).to.equal(30n);
    for (const funder of [c.alice, c.bob, c.other]) await c.escrow.connect(funder).claimRefund();
    expect(await c.escrow.totalReleased()).to.equal(50n);
    expect(await c.escrow.totalRefunded()).to.equal(50n);
    expect(await c.escrow.feePaid()).to.equal(feePaid);
    expect(await c.token.balanceOf(c.admin.address)).to.equal(feeBalance);
    await accounting(c);
  });

  it("admin/platform cancellation blocks deposits and opens immediate fee-free pull refunds", async function () {
    const c = await fixture({ feeBps: 500 }); await c.escrow.connect(c.alice).deposit(40n);
    await expect(c.escrow.connect(c.other).adminCancel(c.reason)).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    await c.factory.connect(c.admin).setEscrowAdmin(c.owner.address, true);
    await c.escrow.connect(c.owner).adminCancel(c.reason);
    await expect(c.escrow.connect(c.bob).deposit(1n)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await c.escrow.connect(c.alice).claimRefund();
    expect(await c.escrow.feePaid()).to.equal(0n);
    const second = await fixture({ feeBps: 500 }); await accept(second);
    await second.escrow.connect(second.platform).adminCancel(second.reason);
    for (const funder of [second.other, second.alice, second.bob]) await second.escrow.connect(funder).claimRefund();
    expect(await second.escrow.totalRefunded()).to.equal(50n);
    expect(await second.escrow.feePaid()).to.equal(2n);
    await accounting(second);
  });

  it("pause blocks new funding/completion without refunding; cancellation still permits exit", async function () {
    const c = await fixture(); await c.escrow.connect(c.alice).deposit(60n);
    await c.registry.connect(c.platform).setPostingFundingPaused(c.listingId, true);
    const paused = await c.escrow.getState(c.alice.address);
    expect(paused.depositsOpen).to.equal(false); expect(paused.refundsEnabled).to.equal(false);
    await expect(c.escrow.connect(c.bob).deposit(40n)).to.be.revertedWithCustomError(c.escrow, "WorkflowInactive");
    await expect(c.escrow.connect(c.alice).claimRefund()).to.be.revertedWithCustomError(c.escrow, "WindowStillOpen");
    await c.registry.connect(c.platform).setPostingFundingPaused(c.listingId, false);
    await c.escrow.connect(c.bob).deposit(40n); await c.escrow.connect(c.solution).acceptFunding(); await evidence(c);
    await c.registry.connect(c.platform).setPostingFundingPaused(c.listingId, true);
    await expect(c.escrow.connect(c.alice).voteCompletion(1n, c.evidence, true)).to.be.revertedWithCustomError(c.escrow, "WorkflowInactive");
    expect((await c.escrow.getState(c.alice.address)).claimable).to.equal(0n);
    await c.escrow.connect(c.platform).adminCancel(c.reason);
    await c.escrow.connect(c.alice).claimRefund(); await c.escrow.connect(c.bob).claimRefund();
    expect(await c.escrow.totalRefunded()).to.equal(50n);
  });

  it("listing content mutation or withdrawal blocks purpose changes and refunds remaining custody", async function () {
    for (const mutate of [async c => c.registry.connect(c.solution).updateOpportunity(c.listingId, c.ethers.id("changed purpose"), c.expiresAt),
      async c => c.registry.connect(c.solution).withdrawOpportunity(c.listingId, c.reason)]) {
      const c = await fixture({ feeBps: 1000 }); await accept(c); await mutate(c);
      const snapshot = await c.escrow.getState(c.alice.address);
      expect(snapshot.state).to.equal(S.Cancelled); expect(snapshot.claimable).to.equal(30n);
      await expect(c.escrow.connect(c.solution).submitEvidence(c.evidence)).to.be.revertedWithCustomError(c.escrow, "WorkflowInactive");
      for (const funder of [c.bob, c.other, c.alice]) await c.escrow.connect(funder).claimRefund();
      expect(await c.escrow.totalRefunded()).to.equal(50n);
      expect(await c.escrow.feePaid()).to.equal(5n);
      await accounting(c);
    }
  });

  it("allocates every remaining odd unit across topups, independent of refund claim order", async function () {
    for (const reverse of [false, true]) {
      const c = await fixture({ target: 13n, feeBps: 2500 });
      await c.escrow.connect(c.alice).deposit(2n); await c.escrow.connect(c.bob).deposit(3n);
      await c.escrow.connect(c.alice).deposit(2n); await c.escrow.connect(c.other).deposit(6n);
      await c.escrow.connect(c.solution).acceptFunding(); await c.escrow.connect(c.platform).adminCancel(c.reason);
      expect((await c.escrow.getState(c.alice.address)).claimable).to.equal(2n);
      expect((await c.escrow.getState(c.bob.address)).claimable).to.equal(1n);
      expect((await c.escrow.getState(c.other.address)).claimable).to.equal(4n);
      const funders = [c.alice, c.bob, c.other]; if (reverse) funders.reverse();
      for (const funder of funders) await c.escrow.connect(funder).claimRefund();
      expect(await c.escrow.totalRefunded()).to.equal(7n); expect(await c.escrow.feePaid()).to.equal(1n);
      expect(await c.token.balanceOf(c.escrowAddress)).to.equal(0n);
      await accounting(c);
    }
  });

  it("uses current token policy/decimals for new risk without trapping refunds on delisting", async function () {
    const c = await fixture(); await c.escrow.connect(c.alice).deposit(40n);
    await c.factory.connect(c.admin).setTokenAllowed(c.tokenAddress, false);
    await expect(c.escrow.connect(c.bob).deposit(1n)).to.be.revertedWithCustomError(c.escrow, "TokenNotListed");
    await c.token.setMetadataReverts(true);
    await c.escrow.connect(c.platform).adminCancel(c.reason);
    expect((await c.escrow.getState(c.alice.address)).claimable).to.equal(40n);
    await c.escrow.connect(c.alice).claimRefund();
    expect(await c.escrow.totalRefunded()).to.equal(40n);
  });

  it("rejects tokens that move incorrect balances and rolls back every ledger change", async function () {
    for (const behavior of [Behavior.RecipientFee, Behavior.SenderFee, Behavior.NoMovement]) {
      const c = await fixture(); await c.token.configure(behavior, false);
      await expect(c.escrow.connect(c.alice).deposit(10n)).to.be.revertedWithCustomError(c.escrow, "UnsupportedTokenBehavior");
      expect(await c.escrow.totalDeposited()).to.equal(0n); expect(await c.escrow.funderCount()).to.equal(0n);
      await c.token.configure(Behavior.Standard, false); await fund(c);
      await c.token.configure(behavior, false);
      await expect(c.escrow.connect(c.solution).acceptFunding()).to.be.revertedWithCustomError(c.escrow, "UnsupportedTokenBehavior");
      expect(await c.escrow.state()).to.equal(S.Open); expect(await c.escrow.totalReleased()).to.equal(0n);
      await accounting(c);
    }
  });

  it("rolls back the majority vote if final transfer fails, permitting the same wallet to retry", async function () {
    const c = await fixture(); await accept(c); await evidence(c);
    await c.token.blockRecipient(c.solution.address);
    await expect(c.escrow.connect(c.alice).voteCompletion(1n, c.evidence, true)).to.be.revertedWithCustomError(c.token, "TestTransferRejected");
    expect(await c.escrow.state()).to.equal(S.Accepted);
    expect(await c.escrow.yesWeight()).to.equal(0n);
    expect(await c.escrow.hasVoted(1n, c.alice.address)).to.equal(false);
    expect(await c.escrow.totalReleased()).to.equal(50n);
    await c.token.blockRecipient(c.ethers.ZeroAddress);
    await c.escrow.connect(c.alice).voteCompletion(1n, c.evidence, true);
    expect(await c.escrow.state()).to.equal(S.Released);
  });

  it("guards every mutating entrypoint during deposits, both payouts and pull refunds", async function () {
    const c = await fixture({ tokenName: "IndependentGuardToken" });
    await c.token.setProbe(true); await accept(c); await evidence(c);
    await c.escrow.connect(c.alice).voteCompletion(1n, c.evidence, true);
    expect(await c.token.guardedCallbacks()).to.equal(5n); // Three deposits, two payouts.
    const refund = await fixture({ tokenName: "IndependentGuardToken" });
    await refund.token.setProbe(true); await fund(refund);
    await refund.escrow.connect(refund.solution).declineFunding(refund.reason);
    for (const funder of [refund.alice, refund.bob, refund.other]) await refund.escrow.connect(funder).claimRefund();
    expect(await refund.token.guardedCallbacks()).to.equal(6n); // Three deposits, three refunds.
    await accounting(refund);
  });

});

// The same direct-contribution boundaries must hold in both funding workflows.
import { fundingPolicyCases } from "./fundingPolicyCases.js";
describe("IndependentFundingEscrow: contribution amount policy", function () {
  fundingPolicyCases(fixture);
  it("rejects off-cent targets at activation", async function () {
    const c = await fixture({ decimals: 6, target: 1_000_000_000n });
    const id = scopedId(c, c.solution, "off-cent-target");
    await c.registry.connect(c.solution).commitOpportunity(id, 2, c.contentHash, c.expiresAt);
    const target = 999_999_999n;
    const hash = c.ethers.keccak256(c.ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "address", "uint256", "uint64", "uint32"],
      [id, c.solution.address, c.tokenAddress, target, c.expiresAt, c.reviewDays]));
    await expect(c.independentFactory.connect(c.solution).createEscrow(id, c.tokenAddress, target, c.reviewDays, hash))
      .to.be.revertedWithCustomError(c.escrow, "AmountPrecisionExceeded").withArgs(2);
  });
});

describe("Independent six-decimal settlement with contribution limits", function () {
  for (const outcome of ["complete", "cancel", "decline"]) {
    it(`preserves ${outcome} with exact fees and fee-free refunds`, async function () {
      const c = await fixture({ decimals: 6, target: 10_010_000n, feeBps: 25 });
      await c.escrow.connect(c.alice).deposit(6_010_000n);
      await c.escrow.connect(c.bob).deposit(4_000_000n);
      if (outcome === "decline") {
        await c.escrow.connect(c.solution).declineFunding(c.reason);
      } else {
        await c.escrow.connect(c.solution).acceptFunding();
        expect(await c.escrow.totalReleased()).to.equal(5_005_000n);
        expect(await c.escrow.feePaid()).to.equal(12_512n);
        if (outcome === "complete") {
          await evidence(c);
          await c.escrow.connect(c.alice).voteCompletion(1n, c.evidence, true);
          expect(await c.escrow.totalReleased()).to.equal(c.target);
          expect(await c.escrow.feePaid()).to.equal(25_025n);
          expect(await c.token.balanceOf(c.solution.address)).to.equal(c.target * 10n + c.target - 25_025n);
        } else {
          await c.escrow.connect(c.admin).adminCancel(c.reason);
        }
      }
      if (outcome !== "complete") {
        await c.escrow.connect(c.bob).claimRefund();
        await c.escrow.connect(c.alice).claimRefund();
        expect(await c.escrow.totalRefunded()).to.equal(outcome === "decline" ? c.target : 5_005_000n);
        expect(await c.escrow.feePaid()).to.equal(outcome === "decline" ? 0n : 12_512n);
      }
      expect(await c.token.balanceOf(c.escrowAddress)).to.equal(0n);
      await accounting(c);
    });
  }
});
