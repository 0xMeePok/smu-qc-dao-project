import { expect } from "chai";
import { fixture, fund, approve, at, assertAccounting, Behavior, State, Status } from "./helpers.js";

describe("FundingEscrow: checked transfers and re-entrancy guards", function () {
  for (const [label, behavior, error] of [
    ["false-return", Behavior.FalseReturn, "SafeERC20FailedOperation"],
    ["recipient-fee", Behavior.RecipientFee, "UnsupportedTokenBehavior"],
    ["sender-fee", Behavior.SenderFee, "UnsupportedTokenBehavior"],
    ["no-movement", Behavior.NoMovement, "UnsupportedTokenBehavior"],
    ["reverting", Behavior.Reverting, "TestTransferRejected"],
  ]) {
    it(`rejects ${label} deposits and rolls back token balances, allowance and history`, async function () {
      const c = await fixture();
      await c.token.connect(c.alice).approve(c.escrowAddress, 100n);
      await c.token.configure(behavior, false);
      const before = await c.token.balanceOf(c.alice.address);
      await expect(c.escrow.connect(c.alice).deposit(100n)).to.be.revertedWithCustomError(
        behavior === Behavior.Reverting ? c.token : c.escrow, error,
      );
      expect(await c.token.balanceOf(c.alice.address)).to.equal(before);
      expect(await c.token.balanceOf(c.escrowAddress)).to.equal(0n);
      expect(await c.token.allowance(c.alice.address, c.escrowAddress)).to.equal(100n);
      expect(await c.escrow.totalDeposited()).to.equal(0n);
      expect(await c.escrow.contributions(c.alice.address)).to.equal(0n);
      expect(await c.escrow.totalDepositCount()).to.equal(0n);
    });

    for (const path of ["release", "refund"]) {
      it(`rolls back a ${label} ${path} and permits a later successful retry`, async function () {
        const c = await fixture();
        if (path === "release") await approve(c); else { await fund(c); await at(c, c.expiresAt); await c.escrow.expire(); }
        // Sender-fee needs a surplus so the token can charge it; exact checks must still reject it.
        if (behavior === Behavior.SenderFee) await c.token.mint(c.escrowAddress, 1n);
        await c.token.configure(behavior, false);
        const beforeBalance = await c.token.balanceOf(c.escrowAddress);
        const operation = () => path === "release" ? c.escrow.release(c.selectionId) : c.escrow.connect(c.alice).claimRefund();
        await expect(operation()).to.be.revertedWithCustomError(behavior === Behavior.Reverting ? c.token : c.escrow, error);
        expect(await c.escrow.state()).to.equal(path === "release" ? State.Locked : State.Expired);
        expect(await c.escrow.totalReleased()).to.equal(0n);
        expect(await c.escrow.totalRefunded()).to.equal(0n);
        expect(await c.escrow.refundedAmounts(c.alice.address)).to.equal(0n);
        expect(await c.token.balanceOf(c.escrowAddress)).to.equal(beforeBalance);
        await c.token.configure(Behavior.Standard, false);
        await operation();
        await assertAccounting(c);
      });
    }
  }

  for (const path of ["release", "refund"]) {
    it(`supports tokens with no return value throughout deposit and ${path}`, async function () {
      const c = await fixture();
      await c.token.configure(Behavior.NoReturn, false);
      if (path === "release") { await approve(c); await c.escrow.release(c.selectionId); }
      else { await fund(c); await at(c, c.expiresAt); await c.escrow.connect(c.alice).claimRefund(); }
      expect(await c.escrow.outstandingBalance()).to.equal(0n);
      await assertAccounting(c);
    });
  }

  for (const path of ["deposit", "release", "refund", "fee release"]) {
    it(`blocks nested calls to all fourteen mutations during ${path} callbacks`, async function () {
      const c = await fixture({ feeBps: path === "fee release" ? 100 : 0 });
      if (path !== "deposit") {
        if (path.includes("release")) await approve(c); else await fund(c);
      }
      await c.token.configure(Behavior.Standard, true);
      if (path === "deposit") await c.escrow.connect(c.alice).deposit(500n);
      else if (path.includes("release")) await c.escrow.release(c.selectionId);
      else { await at(c, c.expiresAt); await c.escrow.connect(c.alice).claimRefund(); }
      expect(await c.token.guardedCallbacks()).to.equal(path === "fee release" ? 2n : 1n);
      expect(await c.escrow.totalDepositCount()).to.equal(1n);
      await assertAccounting(c);
    });
  }

  it("one blocked refund recipient does not prevent other depositors from claiming", async function () {
    const c = await fixture();
    await c.escrow.connect(c.alice).deposit(400n);
    await c.escrow.connect(c.bob).deposit(600n);
    await c.token.blockRecipient(c.alice.address);
    await at(c, c.expiresAt);
    await expect(c.escrow.connect(c.alice).claimRefund()).to.be.revertedWithCustomError(c.token, "TestTransferRejected");
    await c.escrow.connect(c.bob).claimRefund();
    expect((await c.escrow.depositorSummary(c.alice.address)).claimable).to.equal(400n);
    expect((await c.escrow.depositorSummary(c.bob.address)).status).to.equal(Status.Refunded);
    await c.token.blockRecipient(c.ethers.ZeroAddress);
    await c.escrow.connect(c.alice).claimRefund();
    expect(await c.escrow.state()).to.equal(State.Refunded);
    await assertAccounting(c);
  });
});
