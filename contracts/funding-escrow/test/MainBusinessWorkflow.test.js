import { expect } from "chai";
import { fixture, createProposal, scopedId, fund, lock, approve, at, mineAt, State, Status, assertAccounting } from "./helpers.js";
import { submit, approveLater } from "./milestoneHelpers.js";

async function sibling(c, label = "competing-proposal") {
  await createProposal(c, label, { trancheBps: [5000, 5000] }, c.bob);
  const proposalId = scopedId(c, c.bob, label);
  const escrowAddress = await c.registry.proposalEscrow(proposalId);
  const escrow = await c.ethers.getContractAt("FundingEscrow", escrowAddress);
  await c.token.connect(c.alice).approve(escrowAddress, c.ethers.MaxUint256);
  return { ...c, proposalId, escrowAddress, escrow, solution: c.bob, selectionId: c.ethers.id(`selection-${label}`) };
}

describe("Main business workflow: exclusive pending selection and refunds", function () {
  it("blocks sibling deposits and selections while preserving their custody before the handshake", async function () {
    const c = await fixture({ trancheBps: [5000, 5000] });
    const other = await sibling(c);
    await other.escrow.connect(c.alice).deposit(300n);
    await lock(c);
    expect(await c.registry.pendingProposalForPosting(c.postingId)).to.equal(c.proposalId);
    expect(await c.registry.isFundingActive(other.proposalId, other.escrowAddress)).to.equal(false);
    expect(await c.registry.isFundingInvalidated(other.proposalId, other.escrowAddress)).to.equal(false);
    await expect(other.escrow.connect(c.alice).deposit(1n)).to.be.revertedWithCustomError(other.escrow, "WorkflowInactive");
    await expect(other.escrow.lockSelection(other.selectionId, c.bob.address)).to.be.revertedWithCustomError(other.escrow, "WorkflowInactive");
    await expect(other.escrow.refundInvalidated()).to.be.revertedWithCustomError(other.escrow, "InvalidState");
    expect(await other.escrow.totalDeposited()).to.equal(300n);
    expect(await other.escrow.totalRefunded()).to.equal(0n);
    expect(await c.escrow.ownerApproved()).to.equal(false);
    expect(await c.escrow.solutionApproved()).to.equal(false);
  });

  for (const actor of ["owner", "solution"]) it(`${actor} rejection refunds the selected escrow immediately and reopens its sibling`, async function () {
    const c = await fixture({ trancheBps: [5000, 5000], feeBps: 100 });
    const other = await sibling(c);
    await other.escrow.connect(c.alice).deposit(300n);
    await approve(c);
    await expect(c.escrow.connect(c[actor]).rejectSelection(c.selectionId, c.reason))
      .to.emit(c.escrow, "SelectionInvalidated").withArgs(c.selectionId, c.reason);
    expect(await c.escrow.state()).to.equal(State.Cancelled);
    expect(await c.escrow.ownerApproved()).to.equal(false);
    expect(await c.escrow.solutionApproved()).to.equal(false);
    expect((await c.escrow.depositorSummary(c.alice.address)).status).to.equal(Status.Refundable);
    expect(await c.registry.pendingProposalForPosting(c.postingId)).to.equal(c.ethers.ZeroHash);
    expect(await c.registry.acceptedProposalForPosting(c.postingId)).to.equal(c.ethers.ZeroHash);
    await c.escrow.connect(c.alice).claimRefund();
    expect(await c.escrow.totalRefunded()).to.equal(c.target);
    expect(await c.escrow.feePaid()).to.equal(0n);
    await expect(c.escrow.connect(c.alice).deposit(1n)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await other.escrow.connect(c.alice).deposit(700n);
    await other.escrow.lockSelection(other.selectionId, c.bob.address);
    expect(await c.registry.pendingProposalForPosting(c.postingId)).to.equal(other.proposalId);
    await assertAccounting(c);
    await assertAccounting(other);
  });

  it("rejects unauthorized, stale, empty and post-payment rejection requests", async function () {
    const c = await fixture({ trancheBps: [5000, 5000] });
    await lock(c);
    for (const actor of [c.platform, c.alice, c.other, c.admin]) {
      await expect(c.escrow.connect(actor).rejectSelection(c.selectionId, c.reason)).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    }
    await expect(c.escrow.connect(c.owner).rejectSelection(c.ethers.id("stale"), c.reason)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await expect(c.escrow.connect(c.owner).rejectSelection(c.selectionId, c.ethers.ZeroHash)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    await c.escrow.connect(c.owner).approveSelection(c.selectionId);
    await c.escrow.connect(c.solution).approveSelection(c.selectionId);
    await c.escrow.release(c.selectionId);
    await expect(c.escrow.connect(c.owner).rejectSelection(c.selectionId, c.reason)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
  });

  it("expires exactly at the handshake deadline, returns selected funds and reopens siblings", async function () {
    const c = await fixture({ duration: 30 * 86400, trancheBps: [5000, 5000] });
    const other = await sibling(c);
    await other.escrow.connect(c.alice).deposit(300n);
    await lock(c);
    const deadline = await c.escrow.approvalDeadline();
    const anchors = await c.registry.fundingAnchorCount(c.proposalId);
    await at(c, deadline - 1n);
    await expect(c.escrow.expire()).to.be.revertedWithCustomError(c.escrow, "WindowStillOpen");
    await mineAt(c, deadline);
    expect((await c.escrow.depositorSummary(c.alice.address)).claimable).to.equal(c.target);
    await expect(c.escrow.connect(c.owner).rejectSelection(c.selectionId, c.reason)).to.be.revertedWithCustomError(c.escrow, "WindowClosed");
    await c.escrow.connect(c.other).expire();
    expect(await c.escrow.state()).to.equal(State.Expired);
    const expiry = await c.registry.fundingAnchorAt(c.proposalId, anchors);
    expect(expiry.eventType).to.equal(6n);
    expect(expiry.digest).to.equal(c.ethers.keccak256(c.ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "uint256"], [0n, deadline, c.target])));
    expect(await c.registry.pendingProposalForPosting(c.postingId)).to.equal(c.ethers.ZeroHash);
    await c.escrow.connect(c.alice).claimRefund();
    await other.escrow.connect(c.alice).deposit(700n);
    await other.escrow.lockSelection(other.selectionId, c.bob.address);
    await assertAccounting(c);
  });

  it("lets both owners complete the full seven-day handshake after posting submission closes", async function () {
    const c = await fixture({ duration: 3600, trancheBps: [5000, 5000], reviewWindows: [300, 86400] });
    await lock(c);
    const deadline = await c.escrow.approvalDeadline();
    const selectedAt = BigInt((await c.ethers.provider.getBlock("latest")).timestamp);
    expect(deadline - selectedAt).to.equal(7n * 86400n);
    await at(c, c.expiresAt);
    await expect(c.escrow.expire()).to.be.revertedWithCustomError(c.escrow, "WindowStillOpen");
    await c.escrow.connect(c.owner).approveSelection(c.selectionId);
    await expect(c.escrow.release(c.selectionId)).to.be.revertedWithCustomError(c.escrow, "ApprovalIncomplete");
    await c.escrow.connect(c.solution).approveSelection(c.selectionId);
    await c.escrow.release(c.selectionId);
    expect(await c.escrow.totalReleased()).to.equal(500n);
    expect(await c.registry.acceptedProposalForPosting(c.postingId)).to.equal(c.proposalId);
    expect(await c.registry.pendingProposalForPosting(c.postingId)).to.equal(c.ethers.ZeroHash);
  });

  for (const voting of [false, true]) it(`accepted winner pays 50/50 with completion voting ${voting}`, async function () {
    const c = await fixture({ trancheBps: [5000, 5000], funderVoting: voting });
    const other = await sibling(c);
    await other.escrow.connect(c.alice).deposit(300n);
    await approve(c);
    await c.escrow.release(c.selectionId);
    expect(await c.escrow.totalReleased()).to.equal(500n);
    expect(await c.registry.isFundingInvalidated(other.proposalId, other.escrowAddress)).to.equal(true);
    await other.escrow.refundInvalidated();
    await other.escrow.connect(c.alice).claimRefund();
    expect(await other.escrow.totalRefunded()).to.equal(300n);
    const args = await submit(c);
    await approveLater(c, args);
    if (voting) {
      await expect(c.escrow.releaseMilestone(...args)).to.be.revertedWithCustomError(c.escrow, "FunderMajorityRequired");
      await c.escrow.connect(c.alice).voteMilestone(args[1], args[2], true);
    }
    await c.escrow.releaseMilestone(...args);
    expect(await c.escrow.totalReleased()).to.equal(c.target);
    expect(await c.escrow.state()).to.equal(State.Released);
    await assertAccounting(c);
    await assertAccounting(other);
  });

  for (const close of ["cancel", "voidEscrow"]) it(`${close} clears the pending lock without invalidating sibling custody`, async function () {
    const c = await fixture({ trancheBps: [5000, 5000] });
    const other = await sibling(c);
    await lock(c);
    await c.escrow.connect(close === "voidEscrow" ? c.admin : c.platform)[close](c.reason);
    expect(await c.registry.pendingProposalForPosting(c.postingId)).to.equal(c.ethers.ZeroHash);
    expect(await c.registry.isFundingInvalidated(other.proposalId, other.escrowAddress)).to.equal(false);
    await other.escrow.connect(c.alice).deposit(1n);
  });
});
