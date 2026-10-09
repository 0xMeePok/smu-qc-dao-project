import { expect } from "chai";
import { fixture, createProposal, scopedId, approve, lock, fund, at, mineAt, assertAccounting, State, Status, Behavior } from "./helpers.js";

import { first, submit, approveLater, payLater } from "./milestoneHelpers.js";

const plans = [[10000], [3333, 6667], [3333, 3333, 3334], [1000, 2000, 3000, 4000], [1000, 1500, 2000, 2500, 3000]];
describe("Milestone payments: immutable plans, arithmetic and approvals", function () {
  for (const decimals of [0, 6, 18, 77]) for (const plan of plans) {
    it(`${plan.length} tranches conserve principal and cumulative fees at ${decimals} decimals`, async function () {
      const target = decimals === 77 ? 10n ** 75n : 10007n * 10n ** BigInt(Math.max(0, decimals - 2));
      const c = await fixture({ decimals, target, feeBps: 3333, trancheBps: plan });
      let cumulativeBps = 0n, previous = 0n;
      for (let i = 0; i < plan.length; i++) {
        cumulativeBps += BigInt(plan[i]);
        const cumulative = c.target * cumulativeBps / 10000n;
        expect((await c.escrow.milestoneAt(i)).grossAmount).to.equal(cumulative - previous);
        previous = cumulative;
      }
      expect(await c.escrow.milestoneCount()).to.equal(BigInt(plan.length));
      await first(c);
      for (let i = 1; i < plan.length; i++) {
        expect(await c.escrow.ownerApproved()).to.equal(false);
        expect(await c.escrow.solutionApproved()).to.equal(false);
        expect((await c.escrow.depositorSummary(c.alice.address)).status).to.equal(Status.PartiallyReleased);
        await payLater(c); await assertAccounting(c);
      }
      expect(await c.escrow.state()).to.equal(State.Released);
      expect(await c.escrow.totalReleased()).to.equal(c.target);
      expect(await c.escrow.feePaid()).to.equal(c.target * 3333n / 10000n);
      expect(await c.token.balanceOf(c.escrowAddress)).to.equal(0n);
    });
  }

  const invalidPlans = [
    { trancheBps: [] }, { trancheBps: [2000, 2000, 2000, 2000, 1000, 1000] },
    { trancheBps: [0, 10000] }, { trancheBps: [9999] }, { trancheBps: [10001] },
    { trancheBps: [5000, 5000], reviewWindows: [86400] },
    { milestoneHashes: [] }, { reviewWindows: [0] }, { reviewWindows: [365 * 86400 + 1] },
    { target: 1n, trancheBps: [5000, 5000] },
  ];
  for (let i = 0; i < invalidPlans.length; i++) it(`rejects invalid plan ${i} atomically`, async function () {
    const c = await fixture();
    await expect(createProposal(c, "invalid", invalidPlans[i])).to.be.revertedWithCustomError(c.escrow, "InvalidPaymentPlan");
    expect(await c.factory.escrowForProposal(scopedId(c, c.solution, "invalid"))).to.equal(c.ethers.ZeroAddress);
  });
  it("rejects zero milestone descriptions and bounds the first review window", async function () {
    const c = await fixture({ reviewWindows: [365 * 86400] });
    await expect(createProposal(c, "bad", { milestoneHashes: [c.ethers.ZeroHash] })).to.be.revertedWithCustomError(c.escrow, "InvalidPaymentPlan");
    await lock(c);
    const now = BigInt((await c.ethers.provider.getBlock("latest")).timestamp);
    expect(await c.escrow.approvalDeadline()).to.equal(now + 7n * 86400n);
  });
  it("keeps seven days for the handshake even with a shorter first review window", async function () {
    const c = await fixture({ reviewWindows: [3600] }); await lock(c);
    expect(await c.escrow.approvalDeadline()).to.equal(BigInt((await c.ethers.provider.getBlock("latest")).timestamp) + 7n * 86400n);
  });
  it("handles full-width multiplication without intermediate overflow", async function () {
    const c = await fixture({ target: 1n << 250n, feeBps: 9999, trancheBps: [3333, 3333, 3334] });
    await first(c); await payLater(c); await payLater(c);
    expect(await c.escrow.feePaid()).to.equal(c.target * 9999n / 10000n);
    await assertAccounting(c);
  });
  it("requires fresh dual approvals for each evidence version and rejects stale transactions", async function () {
    const c = await fixture({ trancheBps: [3000, 3000, 4000] }); await first(c);
    const args = await submit(c); const deadline = await c.escrow.approvalDeadline();
    await expect(c.escrow.releaseMilestone(...args)).to.be.revertedWithCustomError(c.escrow, "ApprovalIncomplete");
    await c.escrow.connect(c.owner).approveMilestone(...args);
    await expect(c.escrow.releaseMilestone(...args)).to.be.revertedWithCustomError(c.escrow, "ApprovalIncomplete");
    await expect(c.escrow.connect(c.owner).approveMilestone(...args)).to.be.revertedWithCustomError(c.escrow, "AlreadyApproved");
    await expect(c.escrow.connect(c.other).approveMilestone(...args)).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    await c.escrow.connect(c.solution).approveMilestone(...args);
    await expect(c.escrow.connect(c.solution).approveMilestone(...args)).to.be.revertedWithCustomError(c.escrow, "AlreadyApproved");
    const updated = await submit(c, "updated");
    expect(await c.escrow.approvalDeadline()).to.equal(deadline);
    expect(await c.escrow.ownerApproved()).to.equal(false);
    await expect(c.escrow.releaseMilestone(...args)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    await expect(c.escrow.connect(c.solution).submitMilestone(args[1], args[2])).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    await approveLater(c, updated);
    await expect(c.escrow.connect(c.other).releaseMilestone(...updated)).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    await c.escrow.releaseMilestone(...updated);
    await expect(c.escrow.releaseMilestone(...updated)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await expect(c.escrow.release(c.selectionId)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await expect(c.escrow.connect(c.owner).approveSelection(c.selectionId)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await payLater(c);
  });
  it("rejects absent evidence, skipped milestones and unauthorized submission", async function () {
    const c = await fixture({ trancheBps: [5000, 5000] });
    await expect(c.escrow.connect(c.solution).submitMilestone(1, c.reason)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await first(c);
    await expect(c.escrow.connect(c.owner).submitMilestone(1, c.reason)).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    await expect(c.escrow.connect(c.solution).submitMilestone(2, c.reason)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await expect(c.escrow.connect(c.solution).submitMilestone(1, c.ethers.ZeroHash)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    await expect(c.escrow.releaseMilestone(c.selectionId, 1, c.ethers.ZeroHash)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    await expect(c.escrow.approveMilestone(c.selectionId, 0, c.reason)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await expect(c.escrow.releaseMilestone(c.selectionId, 0, c.reason)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await expect(c.escrow.cancel(c.reason)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await expect(c.escrow.invalidateSelection(c.selectionId, c.reason)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
  });
  it("later reviews can continue after posting expiry and time out into partial refunds", async function () {
    const c = await fixture({ duration: 3600, trancheBps: [5000, 5000], reviewWindows: [300, 86400] });
    await first(c); const args = await submit(c);
    await at(c, c.expiresAt); await c.escrow.connect(c.owner).approveMilestone(...args);
    await c.escrow.connect(c.solution).approveMilestone(...args);
    await expect(c.escrow.expire()).to.be.revertedWithCustomError(c.escrow, "WindowStillOpen");
    await mineAt(c, await c.escrow.approvalDeadline());
    expect((await c.escrow.depositorSummary(c.alice.address)).claimable).to.equal(500n);
    await expect(c.escrow.releaseMilestone(...args)).to.be.revertedWithCustomError(c.escrow, "WindowClosed");
    await expect(c.escrow.connect(c.solution).submitMilestone(1, c.reason)).to.be.revertedWithCustomError(c.escrow, "WindowClosed");
    await c.escrow.connect(c.alice).claimRefund();
    expect(await c.escrow.totalRefunded()).to.equal(500n);
    await assertAccounting(c);
  });
  it("rolls back a later tranche including approvals, fees and audit if either transfer fails", async function () {
    const c = await fixture({ trancheBps: [5000, 5000], feeBps: 100 }); await first(c);
    const args = await submit(c); await approveLater(c, args);
    const anchors = await c.registry.fundingAnchorCount(c.proposalId);
    await c.token.blockRecipient(c.admin.address);
    await expect(c.escrow.releaseMilestone(...args)).to.be.revertedWithCustomError(c.token, "TestTransferRejected");
    expect(await c.escrow.totalReleased()).to.equal(500n);
    expect(await c.escrow.feePaid()).to.equal(5n);
    expect(await c.escrow.ownerApproved()).to.equal(true);
    expect(await c.registry.fundingAnchorCount(c.proposalId)).to.equal(anchors);
    await c.token.blockRecipient(c.ethers.ZeroAddress); await c.escrow.releaseMilestone(...args);
  });
});

describe("Optional funder voting: additional to dual approval", function () {
  for (const enabled of [false, true]) it(`voting ${enabled ? "enabled" : "disabled"}: first tranche needs only the two owners`, async function () {
    const c = await fixture({ trancheBps: [5000, 5000], funderVoting: enabled }); await approve(c);
    await expect(c.escrow.connect(c.alice).voteMilestone(0, c.reason, true))
      .to.be.revertedWithCustomError(c.escrow, enabled ? "InvalidState" : "VotingDisabled");
    await c.escrow.release(c.selectionId);
    const args = await submit(c); await approveLater(c, args);
    if (enabled) {
      await expect(c.escrow.releaseMilestone(...args)).to.be.revertedWithCustomError(c.escrow, "FunderMajorityRequired");
      await c.escrow.connect(c.alice).voteMilestone(args[1], args[2], true);
    } else await expect(c.escrow.connect(c.alice).voteMilestone(args[1], args[2], true)).to.be.revertedWithCustomError(c.escrow, "VotingDisabled");
    await c.escrow.releaseMilestone(...args);
  });
  for (const [target, yes, passes] of [[1000n, 499n, false], [1000n, 500n, false], [1000n, 501n, true], [999n, 499n, false], [999n, 500n, true]]) {
    it(`requires >50% of all funding: ${yes}/${target} ${passes ? "passes" : "fails"}`, async function () {
      const c = await fixture({ target, trancheBps: [5000, 5000], funderVoting: true });
      await c.escrow.connect(c.alice).deposit(1n); await c.escrow.connect(c.alice).deposit(yes - 1n);
      await c.escrow.connect(c.bob).deposit(target - yes);
      await c.escrow.lockSelection(c.selectionId, c.solution.address);
      await c.escrow.connect(c.owner).approveSelection(c.selectionId); await c.escrow.connect(c.solution).approveSelection(c.selectionId);
      await c.escrow.release(c.selectionId); const args = await submit(c);
      await c.escrow.connect(c.alice).voteMilestone(args[1], args[2], true);
      expect(await c.escrow.yesWeight()).to.equal(yes);
      await expect(c.escrow.releaseMilestone(...args)).to.be.revertedWithCustomError(c.escrow, "ApprovalIncomplete");
      await c.escrow.connect(c.owner).approveMilestone(...args);
      await expect(c.escrow.releaseMilestone(...args)).to.be.revertedWithCustomError(c.escrow, "ApprovalIncomplete");
      await c.escrow.connect(c.solution).approveMilestone(...args);
      if (passes) await c.escrow.releaseMilestone(...args);
      else await expect(c.escrow.releaseMilestone(...args)).to.be.revertedWithCustomError(c.escrow, "FunderMajorityRequired");
    });
  }
  it("rejects nonfunders, duplicate or stale votes; resets votes after evidence edits and each tranche", async function () {
    const c = await fixture({ trancheBps: [3000, 3000, 4000], funderVoting: true }); await first(c);
    const args = await submit(c);
    await expect(c.escrow.connect(c.bob).voteMilestone(args[1], args[2], true)).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    await c.escrow.connect(c.alice).voteMilestone(args[1], args[2], false);
    expect(await c.escrow.noWeight()).to.equal(c.target);
    await expect(c.escrow.connect(c.alice).voteMilestone(args[1], args[2], true)).to.be.revertedWithCustomError(c.escrow, "AlreadyVoted");
    await approveLater(c, args);
    const updated = await submit(c, "revision");
    expect(await c.escrow.noWeight()).to.equal(0n); expect(await c.escrow.yesWeight()).to.equal(0n);
    await expect(c.escrow.connect(c.alice).voteMilestone(args[1], args[2], true)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    await c.escrow.connect(c.alice).voteMilestone(updated[1], updated[2], true);
    await approveLater(c, updated); await c.escrow.releaseMilestone(...updated);
    expect(await c.escrow.yesWeight()).to.equal(0n);
    await expect(c.escrow.connect(c.alice).voteMilestone(updated[1], updated[2], true)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await payLater(c); await assertAccounting(c);
  });
  it("a stalled vote ends at the fixed deadline with a fee-free refund of the unpaid balance", async function () {
    const c = await fixture({ trancheBps: [2500, 7500], funderVoting: true, feeBps: 400 }); await first(c);
    const args = await submit(c); await approveLater(c, args);
    await at(c, await c.escrow.approvalDeadline()); await c.escrow.expire();
    await c.escrow.connect(c.alice).claimRefund();
    expect(await c.escrow.feePaid()).to.equal(10n); expect(await c.escrow.totalRefunded()).to.equal(750n);
    await assertAccounting(c);
  });
});
