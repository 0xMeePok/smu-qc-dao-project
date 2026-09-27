import { expect } from "chai";
import { fixture, createProposal, scopedId, approve, fund, at, assertAccounting, State } from "./helpers.js";

describe("FundingEscrow: owner fees in basis points", function () {
  for (const [bps, target, fee] of [
    [0, 1000n, 0n], [10, 10000n, 10n], [1, 10000n, 1n],
    [250, 1000n, 25n], [9999, 10000n, 9999n], [10000, 1000n, 1000n],
    [10, 999n, 0n], [3333, 1000n, 333n], [10000, 1n << 250n, 1n << 250n],
  ]) {
    it(`splits ${target} base units at ${bps} bps with a ${fee} fee`, async function () {
      const c = await fixture({ feeBps: bps, target }); await approve(c);
      expect(await c.escrow.BPS_SCALE()).to.equal(10000n);
      expect(await c.factory.BPS_SCALE()).to.equal(10000n);
      expect(await c.escrow.feeBps()).to.equal(BigInt(bps));
      const tx = await c.escrow.release(c.selectionId);
      await expect(tx).to.emit(c.escrow, "FeePaid").withArgs(c.admin.address, fee, bps);
      await expect(tx).to.emit(c.escrow, "Released").withArgs(c.selectionId, c.solution.address, target, target - fee);
      expect(await c.token.balanceOf(c.admin.address)).to.equal(fee);
      expect(await c.token.balanceOf(c.solution.address)).to.equal(target - fee);
      expect(await c.escrow.feePaid()).to.equal(fee);
      expect(await c.escrow.totalReleased()).to.equal(target);
      expect(await c.token.balanceOf(c.escrowAddress)).to.equal(0n);
      await assertAccounting(c);
    });
  }

  it("only the factory owner can adjust fees and values above 10000 are rejected", async function () {
    const c = await fixture();
    for (const who of [c.platform, c.owner, c.solution, c.other]) {
      await expect(c.factory.connect(who).setFeeBps(10)).to.be.revertedWithCustomError(c.factory, "OwnableUnauthorizedAccount").withArgs(who.address);
    }
    await expect(c.factory.connect(c.admin).setFeeBps(10001)).to.be.revertedWithCustomError(c.factory, "InvalidInput");
    await expect(c.factory.connect(c.admin).setFeeBps(10)).to.emit(c.factory, "FeeBpsUpdated").withArgs(0, 10);
    expect(await c.factory.feeBps()).to.equal(10n);
    await c.factory.connect(c.admin).setFeeBps(10000);
    await c.factory.connect(c.admin).setFeeBps(0);
    expect(await c.factory.feeBps()).to.equal(0n);
  });

  it("fee updates and ownership transfers affect only newly created escrows", async function () {
    const c = await fixture({ feeBps: 10 }); await approve(c);
    await c.factory.connect(c.admin).setFeeBps(500);
    await c.factory.connect(c.admin).transferOwnership(c.other.address);
    expect(await c.factory.owner()).to.equal(c.admin.address);
    await expect(c.factory.connect(c.platform).acceptOwnership()).to.be.revertedWithCustomError(c.factory, "OwnableUnauthorizedAccount");
    await c.factory.connect(c.other).acceptOwnership();
    expect(await c.factory.owner()).to.equal(c.other.address);
    await expect(c.factory.connect(c.admin).setFeeBps(20)).to.be.revertedWithCustomError(c.factory, "OwnableUnauthorizedAccount");
    await c.factory.connect(c.other).setFeeBps(250);
    const next = scopedId(c, c.solution, "proposal-2");
    await createProposal(c, "proposal-2");
    const escrow2 = await c.ethers.getContractAt("FundingEscrow", await c.factory.escrowForProposal(next));
    expect(await escrow2.feeBps()).to.equal(250n);
    expect(await escrow2.feeRecipient()).to.equal(c.other.address);
    expect(await c.escrow.feeBps()).to.equal(10n);
    expect(await c.escrow.feeRecipient()).to.equal(c.admin.address);
    await c.escrow.release(c.selectionId);
    expect(await c.token.balanceOf(c.admin.address)).to.equal(1n);
    expect(await c.token.balanceOf(c.solution.address)).to.equal(999n);
  });

  it("does not permit renouncing the fee owner's address", async function () {
    const c = await fixture();
    await expect(c.factory.connect(c.admin).renounceOwnership()).to.be.revertedWithCustomError(c.factory, "OwnershipRenunciationDisabled");
    expect(await c.factory.owner()).to.equal(c.admin.address);
  });

  it("refunds all top-ups without charging any fee even at 100%", async function () {
    const c = await fixture({ feeBps: 10000 });
    await c.escrow.connect(c.alice).deposit(300n);
    await c.escrow.connect(c.alice).deposit(200n);
    await c.escrow.cancel(c.reason);
    await at(c, c.expiresAt); await c.escrow.connect(c.alice).claimRefund();
    expect(await c.escrow.refundedAmounts(c.alice.address)).to.equal(500n);
    expect(await c.escrow.feePaid()).to.equal(0n);
    expect(await c.token.balanceOf(c.admin.address)).to.equal(0n);
    expect(await c.token.balanceOf(c.alice.address)).to.equal(c.target * 10n);
    await assertAccounting(c);
  });

  for (const recipient of ["admin", "solution"]) {
    it(`rolls back the entire release if the ${recipient} payment fails`, async function () {
      const c = await fixture({ feeBps: 100 }); await approve(c);
      await c.token.blockRecipient(c[recipient].address);
      await expect(c.escrow.release(c.selectionId)).to.be.revertedWithCustomError(c.token, "TestTransferRejected");
      expect(await c.token.balanceOf(c.solution.address)).to.equal(0n);
      expect(await c.token.balanceOf(c.admin.address)).to.equal(0n);
      expect(await c.escrow.feePaid()).to.equal(0n);
      expect(await c.escrow.totalReleased()).to.equal(0n);
      expect(await c.escrow.state()).to.equal(State.Locked);
      await c.token.blockRecipient(c.ethers.ZeroAddress);
      await c.escrow.release(c.selectionId);
      expect(await c.token.balanceOf(c.admin.address)).to.equal(10n);
      expect(await c.token.balanceOf(c.solution.address)).to.equal(990n);
      await assertAccounting(c);
    });
  }

  it("accounts correctly when the fee recipient is also the selected solution owner", async function () {
    const c = await fixture({ feeBps: 250 });
    await c.factory.connect(c.admin).transferOwnership(c.solution.address);
    await c.factory.connect(c.solution).acceptOwnership();
    await createProposal(c, "same-recipient");
    c.escrowAddress = await c.factory.escrowForProposal(scopedId(c, c.solution, "same-recipient"));
    c.escrow = await c.ethers.getContractAt("FundingEscrow", c.escrowAddress);
    await c.token.connect(c.alice).approve(c.escrowAddress, c.target);
    await approve(c);
    await c.escrow.release(c.selectionId);
    expect(await c.token.balanceOf(c.solution.address)).to.equal(c.target);
    expect(await c.escrow.feePaid()).to.equal(25n);
    await assertAccounting(c);
  });
});
