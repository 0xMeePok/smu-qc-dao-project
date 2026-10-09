import { expect } from "chai";
import { fixture, createProposal } from "./helpers.js";
import { fundingPolicyCases } from "./fundingPolicyCases.js";

describe("FundingEscrow: contribution amount policy", function () {
  fundingPolicyCases(fixture);
  it("rejects off-cent targets at creation and allows exact cent targets", async function () {
    const c = await fixture({ decimals: 6, target: 1_000_000_000n });
    await expect(createProposal(c, "off-cent", { target: 999_999_999n }))
      .to.be.revertedWithCustomError(c.escrow, "AmountPrecisionExceeded").withArgs(2);
    await createProposal(c, "cent-target", { target: 999_990_000n });
  });
});

describe("Funding amount policy preserves six-decimal settlement", function () {
  it("retains sub-cent milestone fees and funder-approved final payments", async function () {
    const c = await fixture({ decimals: 6, target: 10_010_000n, feeBps: 25, trancheBps: [5000, 5000], funderVoting: true });
    await c.escrow.connect(c.alice).deposit(6_010_000n);
    await c.escrow.connect(c.bob).deposit(4_000_000n);
    await c.escrow.lockSelection(c.selectionId, c.solution.address);
    await c.escrow.connect(c.owner).approveSelection(c.selectionId);
    await c.escrow.connect(c.solution).approveSelection(c.selectionId);
    await c.escrow.release(c.selectionId);
    expect(await c.escrow.totalReleased()).to.equal(5_005_000n);
    expect(await c.escrow.feePaid()).to.equal(12_512n); // Fees are not rounded to cents.
    const evidence = c.ethers.id("completed six-decimal milestone");
    await c.escrow.connect(c.solution).submitMilestone(1n, evidence);
    await c.escrow.connect(c.owner).approveMilestone(c.selectionId, 1n, evidence);
    await c.escrow.connect(c.solution).approveMilestone(c.selectionId, 1n, evidence);
    await c.escrow.connect(c.alice).voteMilestone(1n, evidence, true);
    await c.escrow.releaseMilestone(c.selectionId, 1n, evidence);
    expect(await c.escrow.totalReleased()).to.equal(c.target);
    expect(await c.escrow.feePaid()).to.equal(25_025n);
    expect(await c.token.balanceOf(c.solution.address)).to.equal(c.target - 25_025n);
    expect(await c.token.balanceOf(c.escrowAddress)).to.equal(0n);
  });
  it("returns every unpaid base unit without charging a refund fee", async function () {
    const c = await fixture({ decimals: 6, target: 10_010_000n, feeBps: 25, trancheBps: [5000, 5000] });
    await c.escrow.connect(c.alice).deposit(6_010_000n);
    await c.escrow.connect(c.bob).deposit(4_000_000n);
    await c.escrow.lockSelection(c.selectionId, c.solution.address);
    await c.escrow.connect(c.owner).approveSelection(c.selectionId);
    await c.escrow.connect(c.solution).approveSelection(c.selectionId);
    await c.escrow.release(c.selectionId);
    await c.escrow.connect(c.admin).voidEscrow(c.reason);
    await c.escrow.connect(c.bob).claimRefund();
    await c.escrow.connect(c.alice).claimRefund();
    expect(await c.escrow.totalRefunded()).to.equal(5_005_000n);
    expect(await c.escrow.feePaid()).to.equal(12_512n);
    expect(await c.token.balanceOf(c.escrowAddress)).to.equal(0n);
  });
});
