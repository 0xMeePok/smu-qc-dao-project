import { expect } from "chai";
import { fixture, createProposal, scopedId, fund, lock, approve, at, assertAccounting, State } from "./helpers.js";
import { first, payLater } from "./milestoneHelpers.js";

async function sibling(c, label = "sibling") {
  await createProposal(c, label, { trancheBps: [5000, 5000] });
  const proposalId = scopedId(c, c.solution, label);
  const escrowAddress = await c.registry.proposalEscrow(proposalId);
  const escrow = await c.ethers.getContractAt("FundingEscrow", escrowAddress);
  await c.token.connect(c.alice).approve(escrowAddress, c.ethers.MaxUint256);
  return { ...c, proposalId, escrowAddress, escrow, selectionId: c.ethers.id(`selection-${label}`) };
}

describe("Posting acceptance and canonical escrow funding", function () {
  it("binds the posting on the first payment and retains the same recipient for completion", async function () {
    const c = await fixture({ trancheBps: [5000, 5000] });
    await approve(c);
    expect(await c.registry.acceptedProposalForPosting(c.postingId)).to.equal(c.ethers.ZeroHash);
    await expect(c.escrow.release(c.selectionId)).to.emit(c.registry, "PostingProposalAccepted")
      .withArgs(c.postingId, c.proposalId, c.escrowAddress);
    expect(await c.registry.acceptedProposalForPosting(c.postingId)).to.equal(c.proposalId);
    expect(await c.registry.isFundingActive(c.proposalId, c.escrowAddress)).to.equal(true);
    expect(await c.escrow.totalReleased()).to.equal(500n);
    await payLater(c);
    expect(await c.escrow.state()).to.equal(State.Released);
    expect(await c.escrow.totalReleased()).to.equal(c.target);
    const accepted = await c.registry.queryFilter(c.registry.filters.PostingProposalAccepted(c.postingId));
    expect(accepted).to.have.length(1);
    expect(await c.registry.acceptedProposalForPosting(c.postingId)).to.equal(c.proposalId);
    await assertAccounting(c);
  });

  for (const phase of ["open"]) {
    it(`stops an existing ${phase} sibling and preserves its complete refund entitlement`, async function () {
      const c = await fixture({ trancheBps: [5000, 5000] });
      const other = await sibling(c);
      if (phase === "approved") await approve(other);
      else if (phase === "locked") await lock(other);
      else await fund(other);
      await first(c);
      expect(await c.registry.isFundingActive(other.proposalId, other.escrowAddress)).to.equal(false);
      if (phase === "open") {
        await expect(other.escrow.connect(c.alice).deposit(1n)).to.be.revertedWithCustomError(other.escrow, "WorkflowInactive");
        await expect(other.escrow.lockSelection(other.selectionId, c.solution.address))
          .to.be.revertedWithCustomError(other.escrow, "WorkflowInactive");
      } else {
        await expect(other.escrow.connect(c.owner).approveSelection(other.selectionId))
          .to.be.revertedWithCustomError(other.escrow, "WorkflowInactive");
        await expect(other.escrow.release(other.selectionId)).to.be.revertedWithCustomError(other.escrow, "WorkflowInactive");
      }
      await other.escrow.connect(c.other).refundInvalidated();
      await other.escrow.connect(c.alice).claimRefund();
      expect(await other.escrow.totalRefunded()).to.equal(c.target);
      expect(await other.escrow.totalReleased()).to.equal(0n);
      expect(await c.registry.acceptedProposalForPosting(c.postingId)).to.equal(c.proposalId);
      await payLater(c);
      await assertAccounting(c);
      await assertAccounting(other);
    });
  }

  it("rejects new proposals atomically after acceptance, including after the winning escrow is voided", async function () {
    const c = await fixture({ trancheBps: [5000, 5000] });
    await first(c);
    for (const label of ["after-acceptance", "after-void"]) {
      if (label === "after-void") await c.escrow.connect(c.admin).voidEscrow(c.reason);
      await expect(createProposal(c, label)).to.be.revertedWithCustomError(c.registry, "InvalidState");
      const proposalId = scopedId(c, c.solution, label);
      expect(await c.registry.proposalEscrow(proposalId)).to.equal(c.ethers.ZeroAddress);
      expect(await c.factory.escrowForProposal(proposalId)).to.equal(c.ethers.ZeroAddress);
      await expect(c.registry.getProposal(proposalId)).to.be.revertedWithCustomError(c.registry, "InvalidInput");
    }
    expect(await c.registry.acceptedProposalForPosting(c.postingId)).to.equal(c.proposalId);
  });

  it("accepts only through a canonical escrow and rolls back unsuccessful payouts", async function () {
    const c = await fixture({ trancheBps: [5000, 5000], feeBps: 100 });
    await expect(c.registry.recordFundingEvent(c.proposalId, 8, c.reason, c.platform.address))
      .to.be.revertedWithCustomError(c.registry, "AccessDenied");
    await approve(c);
    const anchors = await c.registry.fundingAnchorCount(c.proposalId);
    await c.token.blockRecipient(c.admin.address);
    await expect(c.escrow.release(c.selectionId)).to.be.revertedWithCustomError(c.token, "TestTransferRejected");
    expect(await c.registry.acceptedProposalForPosting(c.postingId)).to.equal(c.ethers.ZeroHash);
    expect(await c.registry.fundingAnchorCount(c.proposalId)).to.equal(anchors);
    expect(await c.escrow.totalReleased()).to.equal(0n);
    await assertAccounting(c);
    await c.token.blockRecipient(c.ethers.ZeroAddress);
    await c.escrow.release(c.selectionId);
    expect(await c.registry.acceptedProposalForPosting(c.postingId)).to.equal(c.proposalId);
  });

  it("keeps separate postings independent", async function () {
    const c = await fixture();
    const postingId = scopedId(c, c.owner, "posting-2");
    await c.registry.connect(c.owner).commitOpportunity(postingId, 0, c.reason, c.expiresAt);
    const other = await sibling({ ...c, postingId }, "other-posting-proposal");
    await first(c);
    expect(await c.registry.isFundingActive(other.proposalId, other.escrowAddress)).to.equal(true);
    await first(other);
    expect(await c.registry.acceptedProposalForPosting(c.postingId)).to.equal(c.proposalId);
    expect(await c.registry.acceptedProposalForPosting(other.postingId)).to.equal(other.proposalId);
  });
});

describe("Selection invalidation expiry audit", function () {
  it("anchors rejection and immediate refunds when an expired locked selection is invalidated", async function () {
    const c = await fixture();
    await lock(c);
    await at(c, c.expiresAt);
    const tx = await c.escrow.invalidateSelection(c.selectionId, c.reason);
    await expect(tx).to.emit(c.escrow, "StateChanged").withArgs(State.Locked, State.Cancelled);
    const anchors = await c.registry.queryFilter(c.registry.filters.FundingEventAnchored(c.proposalId));
    expect(anchors.map(event => event.args.eventType)).to.deep.equal([0n, 1n, 2n, 4n]);
    const invalidation = anchors.at(-1).args;
    expect(invalidation.escrow).to.equal(c.escrowAddress);
    expect(invalidation.actor).to.equal(c.platform.address);
    expect(invalidation.digest).to.equal(c.ethers.keccak256(c.ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"], [c.selectionId, c.reason])));
    expect(await c.registry.fundingAnchorCount(c.proposalId)).to.equal(4n);
    await c.escrow.connect(c.alice).claimRefund();
    await assertAccounting(c);
  });

  it("does not label an unexpired invalidation as expiry", async function () {
    const c = await fixture();
    await lock(c);
    await c.escrow.invalidateSelection(c.selectionId, c.reason);
    expect(await c.escrow.state()).to.equal(State.Cancelled);
    const anchors = await c.registry.queryFilter(c.registry.filters.FundingEventAnchored(c.proposalId));
    expect(anchors.map(event => event.args.eventType)).to.deep.equal([0n, 1n, 2n, 4n]);
  });
});

describe("Reversible posting funding moderation", function () {
  it("only permits the configured platform signer to pause an existing posting", async function () {
    const c = await fixture();
    for (const actor of [c.owner, c.solution, c.admin, c.other]) {
      await expect(c.registry.connect(actor).setPostingFundingPaused(c.postingId, true))
        .to.be.revertedWithCustomError(c.registry, "AccessDenied");
    }
    await expect(c.registry.setPostingFundingPaused(c.ethers.id("unknown posting"), true))
      .to.be.revertedWithCustomError(c.registry, "InvalidInput");
    await expect(c.registry.setPostingFundingPaused(c.postingId, true))
      .to.emit(c.registry, "PostingFundingPauseChanged").withArgs(c.postingId, true, c.platform.address);
    expect(await c.registry.postingFundingPaused(c.postingId)).to.equal(true);
  });

  it("pauses deposits and new proposals without allowing irreversible invalidation refunds", async function () {
    const c = await fixture();
    await c.escrow.connect(c.alice).deposit(200n);
    await c.registry.setPostingFundingPaused(c.postingId, true);
    expect(await c.registry.isFundingActive(c.proposalId, c.escrowAddress)).to.equal(false);
    expect(await c.registry.isFundingInvalidated(c.proposalId, c.escrowAddress)).to.equal(false);
    expect(await c.registry.isFundingInvalidated(c.proposalId, c.other.address)).to.equal(false);
    expect(await c.registry.isFundingInvalidated(c.proposalId, c.ethers.ZeroAddress)).to.equal(false);
    await expect(c.escrow.connect(c.bob).deposit(100n)).to.be.revertedWithCustomError(c.escrow, "WorkflowInactive");
    await expect(createProposal(c, "paused-proposal")).to.be.revertedWithCustomError(c.registry, "InvalidState");
    await expect(c.escrow.refundInvalidated()).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await expect(c.escrow.connect(c.alice).claimRefund()).to.be.revertedWithCustomError(c.escrow, "WindowStillOpen");
    expect(await c.escrow.state()).to.equal(State.Open);
    await c.registry.setPostingFundingPaused(c.postingId, false);
    expect(await c.registry.isFundingActive(c.proposalId, c.escrowAddress)).to.equal(true);
    await c.escrow.connect(c.bob).deposit(100n);
    await createProposal(c, "restored-proposal");
    expect(await c.escrow.totalDeposited()).to.equal(300n);
  });

  it("pauses selection and payout while keeping approvals and custody available after restoration", async function () {
    const c = await fixture({ trancheBps: [5000, 5000] });
    await fund(c);
    await c.registry.setPostingFundingPaused(c.postingId, true);
    await expect(c.escrow.lockSelection(c.selectionId, c.solution.address)).to.be.revertedWithCustomError(c.escrow, "WorkflowInactive");
    await c.registry.setPostingFundingPaused(c.postingId, false);
    await c.escrow.lockSelection(c.selectionId, c.solution.address);
    await c.escrow.connect(c.owner).approveSelection(c.selectionId);
    await c.escrow.connect(c.solution).approveSelection(c.selectionId);
    const deadline = await c.escrow.approvalDeadline();
    await c.registry.setPostingFundingPaused(c.postingId, true);
    await expect(c.escrow.release(c.selectionId)).to.be.revertedWithCustomError(c.escrow, "WorkflowInactive");
    await expect(c.escrow.refundInvalidated()).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    expect(await c.escrow.totalReleased()).to.equal(0n);
    expect(await c.escrow.ownerApproved()).to.equal(true);
    expect(await c.escrow.solutionApproved()).to.equal(true);
    expect(await c.escrow.approvalDeadline()).to.equal(deadline);
    await c.registry.setPostingFundingPaused(c.postingId, false);
    await c.escrow.release(c.selectionId);
    await payLater(c);
    expect(await c.escrow.state()).to.equal(State.Released);
    await assertAccounting(c);
  });

  for (const trigger of ["withdrawal", "expiry"]) {
    it(`retains existing ${trigger} refunds while a posting is paused`, async function () {
      const c = await fixture();
      await c.escrow.connect(c.alice).deposit(200n);
      await c.registry.setPostingFundingPaused(c.postingId, true);
      if (trigger === "withdrawal") {
        await c.registry.connect(c.owner).withdrawOpportunity(c.postingId, c.reason);
        expect(await c.registry.isFundingInvalidated(c.proposalId, c.escrowAddress)).to.equal(true);
        await c.escrow.refundInvalidated();
      } else await at(c, c.expiresAt);
      await c.escrow.connect(c.alice).claimRefund();
      expect(await c.escrow.totalRefunded()).to.equal(200n);
      await assertAccounting(c);
    });
  }
});
