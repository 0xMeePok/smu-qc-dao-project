import { expect } from "chai";
import { id as declineReason } from "ethers";
import { at, fixture, scopedId, terms, State, Behavior } from "./helpers.js";

const UNIT = 10n ** 6n;
const GRANT = 100_000n * UNIT;

async function grantFixture({ duration = 30 * 86400, prefund = GRANT } = {}) {
  const c = await fixture({ target: 50_000n * UNIT, duration });
  c.postingId = scopedId(c, c.owner, "grant-posting");
  await c.registry.connect(c.owner).commitOpportunity(c.postingId, 1, c.ethers.id("grant scope"), c.expiresAt);
  await c.factory.connect(c.owner).createOpenFundingPool(c.postingId, c.tokenAddress);
  c.poolAddress = await c.factory.openFundingPoolForPosting(c.postingId);
  c.pool = await c.ethers.getContractAt("OpenFundingPool", c.poolAddress);
  await c.token.mint(c.owner.address, 10n * GRANT);
  await c.token.connect(c.owner).approve(c.poolAddress, c.ethers.MaxUint256);
  if (prefund) await c.pool.connect(c.owner).deposit(prefund);
  return c;
}

async function proposal(c, label, signer = c.solution, changes = {}) {
  const id = scopedId(c, signer, label);
  await c.registry.connect(signer).commitProposalWithEscrow(id, c.postingId,
    c.ethers.id(`${label} proposal`), c.ethers.id(`${label} solution`), 0, terms(c, changes));
  const address = await c.factory.escrowForProposal(id);
  return { id, address, signer, escrow: await c.ethers.getContractAt("FundingEscrow", address) };
}

async function accept(c, p) {
  await c.pool.connect(c.owner).selectProposal(p.id);
  await c.pool.connect(p.signer).acceptProposal(p.id);
}

describe("OpenFundingPool: prefunded single-owner grants", function () {
  it("keeps two grant awards independent while a business posting has a pending handshake", async function () {
    const c = await grantFixture();
    const businessPostingId = await c.escrow.postingId();
    const businessProposalId = await c.escrow.proposalId();
    await c.escrow.connect(c.alice).deposit(c.target);
    await c.escrow.connect(c.platform).lockSelection(c.selectionId, c.solution.address);
    const first = await proposal(c, "parallel-grant-one");
    const second = await proposal(c, "parallel-grant-two", c.bob);
    await accept(c, first);
    await accept(c, second);
    for (const p of [first, second]) {
      await p.escrow.connect(c.platform).release(p.id);
      expect(await c.registry.isFundingActive(p.id, p.address)).to.equal(true);
    }
    expect(await c.registry.pendingProposalForPosting(businessPostingId)).to.equal(businessProposalId);
    expect(await c.registry.pendingProposalForPosting(c.postingId)).to.equal(c.ethers.ZeroHash);
    expect(await c.registry.acceptedProposalForPosting(c.postingId)).to.equal(c.ethers.ZeroHash);
    await c.escrow.connect(c.owner).rejectSelection(c.selectionId, c.reason);
    expect(await c.pool.totalAllocated()).to.equal(GRANT);
    expect(await first.escrow.totalReleased()).to.equal(c.target);
    expect(await second.escrow.totalReleased()).to.equal(c.target);
  });

  it("funds two independent 50k awards from 100k and preserves both canonical milestone payouts", async function () {
    const c = await grantFixture();
    const first = await proposal(c, "grant-one");
    const second = await proposal(c, "grant-two", c.bob);
    await c.pool.connect(c.owner).selectProposal(first.id);
    await c.pool.connect(c.owner).selectProposal(second.id);
    expect(await c.registry.pendingProposalForPosting(c.postingId)).to.equal(c.ethers.ZeroHash);
    expect(await c.pool.reservedAmount()).to.equal(GRANT);
    expect(await c.pool.availableBalance()).to.equal(0);
    expect(await c.pool.proposalCount()).to.equal(2);
    expect(await c.pool.proposalAt(1)).to.equal(second.id);
    await c.pool.connect(first.signer).acceptProposal(first.id);
    await c.pool.connect(second.signer).acceptProposal(second.id);
    expect(await c.registry.pendingProposalForPosting(c.postingId)).to.equal(c.ethers.ZeroHash);
    for (const p of [first, second]) {
      expect(await p.escrow.totalDeposited()).to.equal(c.target);
      expect(await c.token.balanceOf(p.address)).to.equal(c.target);
      expect(await p.escrow.contributions(c.owner.address)).to.equal(c.target);
      expect(await p.escrow.contributions(c.poolAddress)).to.equal(0);
      expect(await p.escrow.state()).to.equal(State.Locked);
      expect(await p.escrow.selectionId()).to.equal(p.id);
      expect(await p.escrow.ownerApproved()).to.equal(true);
      expect(await p.escrow.solutionApproved()).to.equal(true);
      await p.escrow.connect(c.platform).release(p.id);
      expect(await p.escrow.state()).to.equal(State.Released);
      expect(await c.registry.isFundingActive(p.id, p.address)).to.equal(true);
    }
    expect(await c.pool.totalAllocated()).to.equal(GRANT);
    expect(await c.pool.reservedAmount()).to.equal(0);
    expect(await c.token.balanceOf(c.poolAddress)).to.equal(0);
    expect(await c.registry.acceptedProposalForPosting(c.postingId)).to.equal(c.ethers.ZeroHash);
  });

  it("requires prefunding before proposals and prevents pooled deposits/selection on grant escrows", async function () {
    const c = await grantFixture({ prefund: 0n });
    await expect(proposal(c, "unfunded")).to.be.revertedWithCustomError(c.factory, "InvalidInput");
    await c.pool.connect(c.owner).deposit(GRANT);
    const p = await proposal(c, "funded");
    await expect(p.escrow.connect(c.alice).deposit(1)).to.be.revertedWithCustomError(p.escrow, "AccessDenied");
    await expect(p.escrow.connect(c.platform).lockSelection(c.selectionId, c.solution.address))
      .to.be.revertedWithCustomError(p.escrow, "AccessDenied");
    await expect(p.escrow.connect(c.owner).rejectSelection(p.id, c.reason))
      .to.be.revertedWithCustomError(p.escrow, "AccessDenied");
    await expect(p.escrow.connect(c.owner).acceptOpenFunding()).to.be.revertedWithCustomError(p.escrow, "AccessDenied");
    await expect(p.escrow.connect(c.owner).voidOpenFunding()).to.be.revertedWithCustomError(p.escrow, "AccessDenied");
  });

  it("rejects unauthorized actors, duplicate offers and oversubscription; top ups allow another award", async function () {
    const c = await grantFixture();
    const first = await proposal(c, "larger", c.solution, { target: 60_000n * UNIT });
    const second = await proposal(c, "remaining", c.bob);
    await expect(c.pool.connect(c.bob).deposit(1)).to.be.revertedWithCustomError(c.pool, "AccessDenied");
    await expect(c.pool.connect(c.solution).selectProposal(first.id)).to.be.revertedWithCustomError(c.pool, "AccessDenied");
    await c.pool.connect(c.owner).selectProposal(first.id);
    await expect(c.pool.connect(c.owner).selectProposal(first.id)).to.be.revertedWithCustomError(c.pool, "InvalidState");
    await expect(c.pool.connect(c.other).acceptProposal(first.id)).to.be.revertedWithCustomError(c.pool, "AccessDenied");
    await expect(c.pool.connect(c.owner).selectProposal(second.id))
      .to.be.revertedWithCustomError(c.pool, "InsufficientAvailableFunding").withArgs(40_000n * UNIT);
    await c.pool.connect(c.owner).deposit(10_000n * UNIT);
    await c.pool.connect(c.owner).selectProposal(second.id);
    await c.pool.connect(c.solution).acceptProposal(first.id);
    await c.pool.connect(c.bob).acceptProposal(second.id);
    await expect(c.pool.connect(c.solution).acceptProposal(first.id)).to.be.revertedWithCustomError(c.pool, "InvalidState");
    expect(await c.pool.totalAllocated()).to.equal(110_000n * UNIT);
  });

  it("voids an unanswered offer at exactly seven days and releases its reservation", async function () {
    const c = await grantFixture();
    const first = await proposal(c, "timeout");
    const second = await proposal(c, "replacement", c.bob, { target: GRANT });
    await c.pool.connect(c.owner).selectProposal(first.id);
    const offer = await c.pool.getOffer(first.id);
    const block = await c.ethers.provider.getBlock("latest");
    expect(offer.acceptanceDeadline - BigInt(block.timestamp)).to.equal(7n * 86400n);
    await expect(c.pool.expireProposal(first.id)).to.be.revertedWithCustomError(c.pool, "WindowStillOpen");
    await at(c, offer.acceptanceDeadline);
    await expect(c.pool.connect(c.solution).acceptProposal(first.id)).to.be.revertedWithCustomError(c.pool, "WindowClosed");
    await at(c, offer.acceptanceDeadline);
    await c.pool.connect(c.other).expireProposal(first.id);
    expect((await c.pool.getOffer(first.id)).state).to.equal(3);
    expect(await c.pool.reservedAmount()).to.equal(0);
    expect(await c.pool.availableBalance()).to.equal(GRANT);
    expect(await c.registry.proposalVoided(first.id)).to.equal(true);
    expect(await first.escrow.state()).to.equal(State.Voided);
    await expect(c.pool.connect(c.owner).selectProposal(first.id)).to.be.revertedWithCustomError(c.pool, "InvalidState");
    await c.pool.connect(c.owner).selectProposal(second.id);
  });

  it("accepts just before the boundary and retains the full window past posting expiry", async function () {
    const c = await grantFixture({ duration: 86400 });
    const p = await proposal(c, "full-window");
    await c.pool.connect(c.owner).selectProposal(p.id);
    const offer = await c.pool.getOffer(p.id);
    await at(c, c.expiresAt);
    await expect(p.escrow.expire()).to.be.revertedWithCustomError(p.escrow, "InvalidState");
    await at(c, offer.acceptanceDeadline - 1n);
    await c.pool.connect(c.solution).acceptProposal(p.id);
    expect(await p.escrow.totalDeposited()).to.equal(c.target);
    expect(await p.escrow.approvalDeadline()).to.be.greaterThan(offer.acceptanceDeadline);
    await p.escrow.connect(c.platform).release(p.id);
    expect(await p.escrow.totalReleased()).to.equal(c.target);
  });

  it("protects reserved funds on close, permits later top ups, and returns unspent custody", async function () {
    const c = await grantFixture({ duration: 86400 });
    const p = await proposal(c, "reserved");
    await c.pool.connect(c.owner).selectProposal(p.id);
    const offer = await c.pool.getOffer(p.id);
    expect(offer.acceptanceDeadline).to.be.greaterThan(c.expiresAt);
    await at(c, c.expiresAt - 1n);
    await expect(c.pool.connect(c.owner).withdrawAvailable(1)).to.be.revertedWithCustomError(c.pool, "WindowStillOpen");
    expect(await c.pool.totalWithdrawn()).to.equal(0n);
    expect(await c.pool.reservedAmount()).to.equal(c.target);
    await at(c, c.expiresAt);
    const unreserved = GRANT - c.target;
    const receipt = await (await c.pool.connect(c.owner).withdrawAvailable(unreserved)).wait();
    expect(BigInt((await c.ethers.provider.getBlock(receipt.blockNumber)).timestamp)).to.equal(c.expiresAt);
    expect(await c.pool.reservedAmount()).to.equal(c.target);
    expect(await c.token.balanceOf(c.poolAddress)).to.equal(c.target);
    await c.pool.connect(c.owner).deposit(100n * UNIT);
    const available = 100n * UNIT;
    await expect(c.pool.connect(c.owner).withdrawAvailable(available + 1n))
      .to.be.revertedWithCustomError(c.pool, "InsufficientAvailableFunding").withArgs(available);
    await c.pool.connect(c.owner).withdrawAvailable(available);
    expect(await c.pool.reservedAmount()).to.equal(c.target);
    expect(await c.token.balanceOf(c.poolAddress)).to.equal(c.target);
    await c.pool.connect(c.solution).acceptProposal(p.id);
    expect(await c.pool.totalWithdrawn()).to.equal(unreserved + available);
    expect(await c.pool.availableBalance()).to.equal(0);
  });

  it("returns unpaid accepted funds directly to the owner wallet on escrow invalidation", async function () {
    const c = await grantFixture();
    const p = await proposal(c, "refund", c.solution, { trancheBps: [5000, 5000] });
    await accept(c, p);
    await p.escrow.connect(c.platform).release(p.id);
    await p.escrow.connect(c.admin).voidEscrow(c.reason);
    const before = await c.token.balanceOf(c.owner.address);
    await p.escrow.connect(c.owner).claimRefund();
    expect(await c.token.balanceOf(c.owner.address) - before).to.equal(c.target / 2n);
    expect(await p.escrow.totalRefunded()).to.equal(c.target / 2n);
    expect(await p.escrow.state()).to.equal(State.Refunded);
  });

  it("releases pending reservations when a proposal or posting is withdrawn, even before deadline", async function () {
    const c = await grantFixture();
    const p = await proposal(c, "withdrawn");
    await c.pool.connect(c.owner).selectProposal(p.id);
    await c.registry.connect(c.solution).withdrawProposal(p.id, c.reason);
    await expect(c.pool.connect(c.solution).acceptProposal(p.id)).to.be.revertedWithCustomError(c.pool, "InvalidState");
    await c.pool.expireProposal(p.id);
    expect(await c.pool.availableBalance()).to.equal(GRANT);
    const next = await proposal(c, "posting-withdrawn", c.bob);
    await c.pool.connect(c.owner).selectProposal(next.id);
    await c.registry.connect(c.owner).withdrawOpportunity(c.postingId, c.reason);
    await c.pool.expireProposal(next.id);
    await c.pool.connect(c.owner).withdrawAvailable(GRANT);
    expect(await c.token.balanceOf(c.poolAddress)).to.equal(0);
  });

  it("keeps custody and offer accounting atomic when the token transfer is rejected", async function () {
    const c = await grantFixture();
    const p = await proposal(c, "atomic");
    await c.pool.connect(c.owner).selectProposal(p.id);
    await c.token.blockRecipient(p.address);
    await expect(c.pool.connect(c.solution).acceptProposal(p.id)).to.be.revertedWithCustomError(c.token, "TestTransferRejected");
    expect((await c.pool.getOffer(p.id)).state).to.equal(1);
    expect(await c.pool.totalAllocated()).to.equal(0);
    expect(await c.pool.reservedAmount()).to.equal(c.target);
    expect(await p.escrow.totalDeposited()).to.equal(0);
    expect(await c.token.allowance(c.poolAddress, p.address)).to.equal(0);
    await c.token.blockRecipient(c.ethers.ZeroAddress);
    await c.pool.connect(c.solution).acceptProposal(p.id);
    expect(await c.token.allowance(c.poolAddress, p.address)).to.equal(0);
  });

  for (const behavior of [Behavior.RecipientFee, Behavior.SenderFee, Behavior.NoMovement]) {
    it(`rejects non-exact prefunding (token behavior ${behavior}) without recording custody`, async function () {
      const c = await grantFixture({ prefund: 0n });
      await c.token.configure(behavior, false);
      await expect(c.pool.connect(c.owner).deposit(GRANT)).to.be.revertedWithCustomError(c.pool, "UnsupportedTokenBehavior");
      expect(await c.pool.totalDeposited()).to.equal(0);
      expect(await c.registry.postingFundingStarted(c.postingId)).to.equal(false);
    });
  }

  it("freezes proposal content at grant selection while custody is still in the pool", async function () {
    const c = await grantFixture();
    const p = await proposal(c, "selection-freeze");
    const selectedHash = c.ethers.id("researcher revised proposal before selection");
    const selectedSolutionHash = c.ethers.id("researcher revised solution before selection");
    await c.registry.connect(c.solution).updateHashes(p.id, selectedHash, selectedSolutionHash, 0);
    expect(await c.registry.revisionCount(p.id)).to.equal(2);
    await c.pool.connect(c.owner).selectProposal(p.id);
    expect(await p.escrow.state()).to.equal(State.Open);
    expect(await p.escrow.totalDeposited()).to.equal(0);
    const edit = () => c.registry.connect(c.solution).updateHashes(p.id,
      c.ethers.id("edited after owner selection"), c.ethers.id("solution edited after owner selection"), 0);
    await expect(edit()).to.be.revertedWithCustomError(c.registry, "FundingTermsFrozen");
    const frozen = await c.registry.getProposal(p.id);
    expect(frozen.proposalHash).to.equal(selectedHash);
    expect(frozen.solutionHash).to.equal(selectedSolutionHash);
    expect(frozen.researcher).to.equal(c.solution.address);
    expect(await c.registry.revisionCount(p.id)).to.equal(2);
    await c.pool.connect(c.solution).acceptProposal(p.id);
    await expect(edit()).to.be.revertedWithCustomError(c.registry, "FundingTermsFrozen");
    expect(await p.escrow.proposalOwner()).to.equal(c.solution.address);
    expect(await p.escrow.totalDeposited()).to.equal(c.target);
  });

  it("enforces token listing and owner-only canonical pool creation", async function () {
    const c = await grantFixture();
    const p = await proposal(c, "frozen");
    await expect(c.factory.connect(c.other).createOpenFundingPool(c.postingId, c.tokenAddress))
      .to.be.revertedWithCustomError(c.factory, "AccessDenied");
    await expect(c.factory.connect(c.owner).createOpenFundingPool(c.postingId, c.tokenAddress))
      .to.be.revertedWithCustomError(c.factory, "InvalidInput");
    await c.pool.connect(c.owner).selectProposal(p.id);
    await c.factory.connect(c.admin).setTokenAllowed(c.tokenAddress, false);
    await expect(c.pool.connect(c.owner).deposit(1)).to.be.revertedWithCustomError(c.pool, "TokenNotListed");
    await expect(c.pool.connect(c.solution).acceptProposal(p.id)).to.be.revertedWithCustomError(c.pool, "TokenNotListed");
    const offer = await c.pool.getOffer(p.id);
    await at(c, offer.acceptanceDeadline);
    await c.pool.expireProposal(p.id); // Delisting never blocks an exit.
  });

  it("keeps grant scope isolated and rejects mismatched grant tokens or pooled funder voting", async function () {
    const c = await grantFixture();
    const businessId = scopedId(c, c.owner, "posting-1");
    await expect(c.factory.connect(c.owner).createOpenFundingPool(businessId, c.tokenAddress))
      .to.be.revertedWithCustomError(c.factory, "InvalidInput");
    const otherToken = await c.ethers.deployContract("EscrowTestToken", [18]);
    await c.factory.connect(c.admin).setTokenAllowed(await otherToken.getAddress(), true);
    await expect(proposal(c, "wrong-token", c.solution, { token: await otherToken.getAddress() }))
      .to.be.revertedWithCustomError(c.factory, "InvalidInput");
    await expect(proposal(c, "pooled-voting", c.solution, { funderVoting: true }))
      .to.be.revertedWithCustomError(c.factory, "InvalidInput");
    const deployer = await c.ethers.getContractAt("OpenFundingPoolDeployer", await c.factory.openFundingPoolDeployer());
    await expect(deployer.connect(c.owner).deploy(c.postingId, c.owner.address, c.tokenAddress, c.registryAddress))
      .to.be.revertedWithCustomError(deployer, "AccessDenied");
    expect(await c.pool.factory()).to.equal(await c.factory.getAddress());
    expect(await c.pool.auditRegistry()).to.equal(c.registryAddress);
  });
});

describe("OpenFundingPool: researcher declines a pending grant offer", function () {
  it("returns the reservation to the available balance, voids the grant escrow and records the reason hash", async function () {
    const c = await grantFixture();
    const first = await proposal(c, "decline-one");
    const second = await proposal(c, "decline-two", c.bob);
    const third = await proposal(c, "after-decline", c.other);
    await c.pool.connect(c.owner).selectProposal(first.id);
    await c.pool.connect(c.owner).selectProposal(second.id);
    expect(await c.pool.availableBalance()).to.equal(0);
    const poolBalance = await c.token.balanceOf(c.poolAddress);
    const reasonHash = declineReason("Our team has secured other funding for this work.");
    const anchorsBefore = await c.registry.fundingAnchorCount(first.id);
    await expect(c.pool.connect(c.solution).declineProposal(first.id, reasonHash))
      .to.emit(c.pool, "ProposalDeclined").withArgs(first.id, c.solution.address, first.address, c.target, reasonHash)
      .and.to.emit(c.pool, "ProposalVoided").withArgs(first.id, c.target)
      .and.to.emit(first.escrow, "EscrowVoided");
    const offer = await c.pool.getOffer(first.id);
    expect(offer.state).to.equal(3);
    expect(offer.amount).to.equal(c.target);
    expect(await c.pool.offerState(first.id)).to.equal(3);
    expect(await c.pool.declineReasonHash(first.id)).to.equal(reasonHash);
    expect(await c.pool.declineReasonHash(second.id)).to.equal(c.ethers.ZeroHash);
    expect(await c.pool.reservedAmount()).to.equal(c.target);
    expect(await c.pool.availableBalance()).to.equal(GRANT - c.target);
    expect(await c.pool.totalAllocated()).to.equal(0);
    expect(await c.pool.totalDeposited()).to.equal(GRANT);
    expect(await c.token.balanceOf(c.poolAddress)).to.equal(poolBalance);
    expect(await first.escrow.state()).to.equal(State.Voided);
    expect(await first.escrow.totalDeposited()).to.equal(0);
    expect(await c.registry.proposalVoided(first.id)).to.equal(true);
    expect(await c.registry.isFundingActive(first.id, first.address)).to.equal(false);
    expect(await c.registry.fundingAnchorCount(first.id)).to.equal(anchorsBefore + 1n);
    expect((await c.registry.fundingAnchorAt(first.id, anchorsBefore)).eventType).to.equal(9n); // FundingEvent.Voided
    // The other offer is untouched and the released funds can back a new award.
    expect((await c.pool.getOffer(second.id)).state).to.equal(1);
    await c.pool.connect(c.bob).acceptProposal(second.id);
    await c.pool.connect(c.owner).selectProposal(third.id);
    await c.pool.connect(c.other).acceptProposal(third.id);
    expect(await c.pool.totalAllocated()).to.equal(GRANT);
    expect(await c.pool.availableBalance()).to.equal(0);
  });

  it("lets only the proposal's researcher decline", async function () {
    const c = await grantFixture();
    const p = await proposal(c, "decline-access");
    const other = await proposal(c, "decline-access-other", c.bob);
    await c.pool.connect(c.owner).selectProposal(p.id);
    await c.pool.connect(c.owner).selectProposal(other.id);
    const reasonHash = declineReason("Not the right fit for our lab at this time.");
    for (const actor of [c.owner, c.bob, c.other, c.platform, c.admin]) {
      await expect(c.pool.connect(actor).declineProposal(p.id, reasonHash)).to.be.revertedWithCustomError(c.pool, "AccessDenied");
    }
    await expect(c.pool.connect(c.solution).declineProposal(other.id, reasonHash)).to.be.revertedWithCustomError(c.pool, "AccessDenied");
    expect((await c.pool.getOffer(p.id)).state).to.equal(1);
    expect(await c.pool.reservedAmount()).to.equal(GRANT);
  });

  it("requires a reason hash and a pending offer, and rejects a second decline", async function () {
    const c = await grantFixture();
    const unselected = await proposal(c, "decline-unselected");
    const accepted = await proposal(c, "decline-accepted", c.bob);
    const reasonHash = declineReason("We would rather pursue a different sponsor.");
    await expect(c.pool.connect(c.solution).declineProposal(unselected.id, reasonHash)).to.be.revertedWithCustomError(c.pool, "InvalidState");
    await accept(c, accepted);
    await expect(c.pool.connect(c.bob).declineProposal(accepted.id, reasonHash)).to.be.revertedWithCustomError(c.pool, "InvalidState");
    expect(await c.pool.totalAllocated()).to.equal(c.target);
    await c.pool.connect(c.owner).selectProposal(unselected.id);
    await expect(c.pool.connect(c.solution).declineProposal(unselected.id, c.ethers.ZeroHash)).to.be.revertedWithCustomError(c.pool, "InvalidInput");
    await c.pool.connect(c.solution).declineProposal(unselected.id, reasonHash);
    await expect(c.pool.connect(c.solution).declineProposal(unselected.id, reasonHash)).to.be.revertedWithCustomError(c.pool, "InvalidState");
    await expect(c.pool.connect(c.solution).acceptProposal(unselected.id)).to.be.revertedWithCustomError(c.pool, "InvalidState");
    await expect(c.pool.expireProposal(unselected.id)).to.be.revertedWithCustomError(c.pool, "InvalidState");
    await expect(c.pool.connect(c.owner).selectProposal(unselected.id)).to.be.revertedWithCustomError(c.pool, "InvalidState");
    await expect(c.registry.connect(c.solution).updateHashes(unselected.id, c.ethers.id("edit"), c.ethers.id("edit solution"), 0))
      .to.be.revertedWithCustomError(c.registry, "InvalidState");
    expect(await c.pool.reservedAmount()).to.equal(0);
    expect(await c.pool.availableBalance()).to.equal(GRANT - c.target);
  });

  it("closes at the acceptance deadline, after which only expiry releases the reservation", async function () {
    const c = await grantFixture();
    const late = await proposal(c, "decline-late");
    const edge = await proposal(c, "decline-edge", c.bob);
    await c.pool.connect(c.owner).selectProposal(late.id);
    const reasonHash = declineReason("The project timeline no longer works for us.");
    const offer = await c.pool.getOffer(late.id);
    await at(c, offer.acceptanceDeadline);
    await expect(c.pool.connect(c.solution).declineProposal(late.id, reasonHash)).to.be.revertedWithCustomError(c.pool, "WindowClosed");
    await at(c, offer.acceptanceDeadline);
    await c.pool.expireProposal(late.id);
    expect(await c.pool.declineReasonHash(late.id)).to.equal(c.ethers.ZeroHash);
    expect(await c.pool.availableBalance()).to.equal(GRANT);
    await c.pool.connect(c.owner).selectProposal(edge.id);
    const edgeOffer = await c.pool.getOffer(edge.id);
    await at(c, edgeOffer.acceptanceDeadline - 1n);
    await c.pool.connect(c.bob).declineProposal(edge.id, reasonHash);
    expect(await c.pool.availableBalance()).to.equal(GRANT);
    expect(await c.pool.declineReasonHash(edge.id)).to.equal(reasonHash);
  });

  it("is never blocked by token delisting, a moderation pause, a withdrawn proposal or a closed posting", async function () {
    const c = await grantFixture({ duration: 86400 });
    const delisted = await proposal(c, "decline-delisted");
    const paused = await proposal(c, "decline-paused", c.bob);
    await c.pool.connect(c.owner).selectProposal(delisted.id);
    await c.pool.connect(c.owner).selectProposal(paused.id);
    const reasonHash = declineReason("Circumstances changed after we applied.");
    await c.factory.connect(c.admin).setTokenAllowed(c.tokenAddress, false);
    await c.pool.connect(c.solution).declineProposal(delisted.id, reasonHash);
    await c.registry.setPostingFundingPaused(c.postingId, true);
    await at(c, c.expiresAt); // The posting closes while the offer window is still open.
    await c.pool.connect(c.bob).declineProposal(paused.id, reasonHash);
    expect(await c.pool.reservedAmount()).to.equal(0);
    expect(await c.pool.availableBalance()).to.equal(GRANT);
    await c.pool.connect(c.owner).withdrawAvailable(GRANT);
    expect(await c.token.balanceOf(c.poolAddress)).to.equal(0);

    const w = await grantFixture();
    const withdrawn = await proposal(w, "decline-withdrawn");
    await w.pool.connect(w.owner).selectProposal(withdrawn.id);
    await w.registry.connect(w.solution).withdrawProposal(withdrawn.id, w.reason);
    await w.pool.connect(w.solution).declineProposal(withdrawn.id, reasonHash);
    expect(await w.pool.availableBalance()).to.equal(GRANT);
    expect(await withdrawn.escrow.state()).to.equal(State.Voided);
  });
});
