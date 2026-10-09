import { expect } from "chai";

export function fundingPolicyCases(makeFixture) {
  for (const decimals of [0, 1, 2, 6, 18]) {
    it(`accepts one-token contributions and an exact finish at ${decimals} decimals`, async function () {
      const unit = 10n ** BigInt(decimals);
      const c = await makeFixture({ decimals, target: 1000n * unit });
      await c.escrow.connect(c.alice).deposit(999n * unit);
      await c.escrow.connect(c.bob).deposit(unit);
      expect(await c.escrow.totalDeposited()).to.equal(c.target);
      expect(await c.token.balanceOf(c.escrowAddress)).to.equal(c.target);
    });
    if (decimals > 0) {
      it(`blocks sub-token deposits and dust remainder at ${decimals} decimals before token transfer`, async function () {
        const unit = 10n ** BigInt(decimals), half = unit / 2n;
        const c = await makeFixture({ decimals, target: 1000n * unit });
        const before = await c.token.balanceOf(c.alice.address);
        await expect(c.escrow.connect(c.alice).deposit(half))
          .to.be.revertedWithCustomError(c.escrow, "ContributionBelowMinimum").withArgs(unit);
        await expect(c.escrow.connect(c.alice).deposit(c.target - half))
          .to.be.revertedWithCustomError(c.escrow, "ContributionLeavesDust").withArgs(half, unit);
        expect(await c.escrow.totalDeposited()).to.equal(0n);
        expect(await c.escrow.contributions(c.alice.address)).to.equal(0n);
        expect(await c.token.balanceOf(c.alice.address)).to.equal(before);
        expect(await c.token.balanceOf(c.escrowAddress)).to.equal(0n);
        // A target itself may be below 1; its exact remaining balance is fundable.
        const small = await makeFixture({ decimals, target: half });
        await small.escrow.connect(small.alice).deposit(half);
        expect(await small.escrow.totalDeposited()).to.equal(half);
      });
    }
    if (decimals > 2) {
      it(`rejects more than two decimals but accepts hundredths at ${decimals} decimals`, async function () {
        const unit = 10n ** BigInt(decimals), cent = unit / 100n;
        const c = await makeFixture({ decimals, target: 1000n * unit });
        await expect(c.escrow.connect(c.alice).deposit(unit + 1n))
          .to.be.revertedWithCustomError(c.escrow, "AmountPrecisionExceeded").withArgs(2);
        await expect(c.escrow.connect(c.alice).deposit(999n * unit + unit - 1n))
          .to.be.revertedWithCustomError(c.escrow, "AmountPrecisionExceeded").withArgs(2);
        await c.escrow.connect(c.alice).deposit(unit + cent);
        await c.escrow.connect(c.bob).deposit(c.target - unit - cent);
        expect(await c.escrow.totalDeposited()).to.equal(c.target);
      });
    }
  }
}
