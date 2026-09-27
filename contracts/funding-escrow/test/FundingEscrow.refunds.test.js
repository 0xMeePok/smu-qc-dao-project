import { expect } from "chai";
import { fixture, fund, at, assertAccounting, State, Status, Behavior } from "./helpers.js";
import { first, submit, approveLater, payLater } from "./milestoneHelpers.js";

async function sharedFunding(c) {
  await c.escrow.connect(c.alice).deposit(1n);
  await c.escrow.connect(c.bob).deposit(333n);
  await c.escrow.connect(c.alice).deposit(332n);
  await c.escrow.connect(c.other).deposit(c.target - 666n);
  await c.escrow.lockSelection(c.selectionId, c.solution.address);
  await c.escrow.connect(c.owner).approveSelection(c.selectionId);
  await c.escrow.connect(c.solution).approveSelection(c.selectionId);
}

describe("Admin voids and partial refunds", function () {
  for (const paid of [0, 1, 2, 3, 4]) for (const feeBps of [0, 10, 3333, 10000]) {
    it(`void after ${paid}/5 payments at ${feeBps} bps returns all unpaid funds with no refund fee`, async function () {
      const c = await fixture({ target: 1007n, feeBps, trancheBps: [1000, 1500, 2000, 2500, 3000] });
      await sharedFunding(c);
      if (paid) await c.escrow.release(c.selectionId);
      for (let i = 1; i < paid; i++) {
        const args = await submit(c); await approveLater(c, args); await c.escrow.releaseMilestone(...args);
      }
      const released = await c.escrow.totalReleased(); const fees = await c.escrow.feePaid();
      const pool = c.target - released;
      await c.escrow.connect(c.admin).voidEscrow(c.reason);
      expect(await c.registry.proposalVoided(c.proposalId)).to.equal(true);
      expect(await c.escrow.refundPool()).to.equal(pool);
      let total = 0n;
      for (const who of [c.other, c.alice, c.bob]) {
        const before = await c.escrow.depositorSummary(who.address);
        expect(before.status).to.equal(Status.Refundable);
        const contributed = await c.escrow.contributions(who.address);
        const prefix = await c.escrow.fundingPrefixEnd(who.address);
        const expected = pool * prefix / c.target - pool * (prefix - contributed) / c.target;
        expect(before.claimable).to.equal(expected);
        expect(before.released + before.claimable).to.equal(contributed);
        await c.escrow.connect(who).claimRefund(); total += expected;
        expect((await c.escrow.depositorSummary(who.address)).status).to.equal(Status.Refunded);
        await assertAccounting(c);
      }
      expect(total).to.equal(pool); expect(await c.escrow.totalRefunded()).to.equal(pool);
      expect(await c.escrow.state()).to.equal(State.Refunded);
      expect(await c.escrow.feePaid()).to.equal(fees);
      expect(fees).to.equal(released * BigInt(feeBps) / 10000n);
      expect(await c.token.balanceOf(c.admin.address)).to.equal(fees);
      expect(await c.token.balanceOf(c.escrowAddress)).to.equal(0n);
      expect(await c.escrow.depositCounts(c.alice.address)).to.equal(2n);
      await expect(c.escrow.connect(c.admin).voidEscrow(c.reason)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
      await expect(c.escrow.connect(c.alice).claimRefund()).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    });
  }
  for (const phase of ["empty", "open", "cancelled", "expired"]) it(`voids ${phase} escrow immediately`, async function () {
    const c = await fixture();
    if (phase !== "empty") await c.escrow.connect(c.alice).deposit(200n);
    if (phase === "cancelled") await c.escrow.cancel(c.reason);
    if (phase === "expired") { await at(c, c.expiresAt); await c.escrow.expire(); }
    await c.escrow.connect(c.admin).voidEscrow(c.reason);
    expect(await c.escrow.state()).to.equal(State.Voided);
    if (phase !== "empty") await c.escrow.connect(c.alice).claimRefund();
    else await expect(c.escrow.connect(c.alice).claimRefund()).to.be.revertedWithCustomError(c.escrow, "NothingToRefund");
    await assertAccounting(c);
  });
  it("preserves entitlements when moderation follows an earlier partial claim", async function () {
    const c = await fixture({ trancheBps: [5000, 5000] }); await sharedFunding(c);
    await c.escrow.release(c.selectionId);
    await at(c, await c.escrow.approvalDeadline()); await c.escrow.connect(c.alice).claimRefund();
    const already = await c.escrow.totalRefunded();
    await c.escrow.connect(c.admin).voidEscrow(c.reason);
    expect(await c.escrow.refundPool()).to.equal(500n);
    expect(await c.escrow.totalRefunded()).to.equal(already);
    await expect(c.escrow.connect(c.alice).claimRefund()).to.be.revertedWithCustomError(c.escrow, "NothingToRefund");
    await c.escrow.connect(c.bob).claimRefund(); await c.escrow.connect(c.other).claimRefund();
    expect(await c.escrow.totalRefunded()).to.equal(500n); await assertAccounting(c);
  });
  it("authorizes current factory owner and revocable admins, never platform alone", async function () {
    const c = await fixture();
    for (const who of [c.platform, c.owner, c.solution, c.alice]) {
      await expect(c.escrow.connect(who).voidEscrow(c.reason)).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
      await expect(c.factory.connect(who).setEscrowAdmin(c.other.address, true)).to.be.revertedWithCustomError(c.factory, "OwnableUnauthorizedAccount");
    }
    await expect(c.factory.connect(c.admin).setEscrowAdmin(c.ethers.ZeroAddress, true)).to.be.revertedWithCustomError(c.factory, "InvalidInput");
    await c.factory.connect(c.admin).setEscrowAdmin(c.other.address, true);
    expect(await c.factory.isEscrowAdmin(c.other.address)).to.equal(true);
    await c.factory.connect(c.admin).setEscrowAdmin(c.other.address, false);
    await expect(c.escrow.connect(c.other).voidEscrow(c.reason)).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    await c.factory.connect(c.admin).transferOwnership(c.other.address); await c.factory.connect(c.other).acceptOwnership();
    await expect(c.escrow.connect(c.admin).voidEscrow(c.reason)).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    await expect(c.escrow.connect(c.other).voidEscrow(c.ethers.ZeroHash)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    await c.factory.connect(c.other).setEscrowAdmin(c.bob.address, true);
    await c.escrow.connect(c.bob).voidEscrow(c.reason);
    await expect(c.escrow.connect(c.bob).voidEscrow(c.reason)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
  });
  it("cannot claw back a fully paid proposal", async function () {
    const c = await fixture(); await first(c);
    await expect(c.escrow.connect(c.admin).voidEscrow(c.reason)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await expect(c.escrow.refundInvalidated()).to.be.revertedWithCustomError(c.escrow, "InvalidState");
  });
  it("tiny contributions and indivisible refunds leave no dust or claim-order dependency", async function () {
    const c = await fixture({ target: 3n, trancheBps: [6667, 3333] });
    for (const who of [c.alice, c.bob, c.other]) await c.escrow.connect(who).deposit(1n);
    await c.escrow.lockSelection(c.selectionId, c.solution.address);
    await c.escrow.connect(c.owner).approveSelection(c.selectionId); await c.escrow.connect(c.solution).approveSelection(c.selectionId);
    await c.escrow.release(c.selectionId); await c.escrow.connect(c.admin).voidEscrow(c.reason);
    expect((await c.escrow.depositorSummary(c.alice.address)).status).to.equal(Status.Released);
    await expect(c.escrow.connect(c.alice).claimRefund()).to.be.revertedWithCustomError(c.escrow, "NothingToRefund");
    expect((await c.escrow.depositorSummary(c.other.address)).claimable).to.equal(1n);
    await c.escrow.connect(c.other).claimRefund();
    expect(await c.token.balanceOf(c.escrowAddress)).to.equal(0n);
    await assertAccounting(c);
  });
  it("blocks all fourteen nested mutations on later payment and partial refund", async function () {
    const c = await fixture({ trancheBps: [3000, 3000, 4000], feeBps: 100 }); await first(c);
    await c.token.configure(Behavior.Standard, true);
    await payLater(c);
    expect(await c.token.guardedCallbacks()).to.equal(2n);
    await c.escrow.connect(c.admin).voidEscrow(c.reason);
    await c.escrow.connect(c.alice).claimRefund();
    expect(await c.token.guardedCallbacks()).to.equal(3n); await assertAccounting(c);
  });
  it("an unsuccessful partial refund leaves accounting and audit unchanged; donations are excluded", async function () {
    const c = await fixture({ trancheBps: [5000, 5000] }); await first(c);
    await c.token.mint(c.escrowAddress, 17n); await c.escrow.connect(c.admin).voidEscrow(c.reason);
    const anchors = await c.registry.fundingAnchorCount(c.proposalId);
    await c.token.blockRecipient(c.alice.address);
    await expect(c.escrow.connect(c.alice).claimRefund()).to.be.revertedWithCustomError(c.token, "TestTransferRejected");
    expect(await c.escrow.totalRefunded()).to.equal(0n); expect(await c.registry.fundingAnchorCount(c.proposalId)).to.equal(anchors);
    await c.token.blockRecipient(c.ethers.ZeroAddress); await c.escrow.connect(c.alice).claimRefund();
    expect(await c.token.balanceOf(c.escrowAddress)).to.equal(17n); await assertAccounting(c);
  });
});

describe("Full uint256 accounting boundary", function () {
  it("conserves a maximum-size pool across tranche fees and three partial refunds", async function () {
    const target = (1n << 256n) - 1n;
    const c = await fixture({ target, feeBps: 9999, trancheBps: [3333, 3333, 3334] });
    for (const who of [c.alice, c.bob, c.other]) await c.escrow.connect(who).deposit(target / 3n);
    await c.escrow.lockSelection(c.selectionId, c.solution.address);
    await c.escrow.connect(c.owner).approveSelection(c.selectionId);
    await c.escrow.connect(c.solution).approveSelection(c.selectionId);
    await c.escrow.release(c.selectionId);
    const gross = target * 3333n / 10000n;
    expect(await c.escrow.totalReleased()).to.equal(gross);
    expect(await c.escrow.feePaid()).to.equal(gross * 9999n / 10000n);
    await c.escrow.connect(c.admin).voidEscrow(c.reason);
    let returned = 0n;
    for (const who of [c.bob, c.other, c.alice]) {
      returned += (await c.escrow.depositorSummary(who.address)).claimable;
      await c.escrow.connect(who).claimRefund();
      await assertAccounting(c);
    }
    expect(returned).to.equal(target - gross);
    expect(await c.escrow.totalRefunded()).to.equal(target - gross);
    expect(await c.token.balanceOf(c.escrowAddress)).to.equal(0n);
    let balances = 0n;
    for (const who of [c.admin, c.solution, c.alice, c.bob, c.other]) balances += await c.token.balanceOf(who.address);
    expect(balances).to.equal(target);
  });
});
