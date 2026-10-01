import { expect } from "chai";
import { fixture, assertAccounting, State, Behavior } from "./helpers.js";

async function checkPrefixes(c, funders) {
  let total = 0n;
  for (const { signer, amount } of funders) {
    total += amount;
    expect(await c.escrow.fundingPrefixEnd(signer.address)).to.equal(total);
  }
  expect(await c.escrow.totalDeposited()).to.equal(total);
  expect(await c.escrow.funderCount()).to.equal(BigInt(funders.length));
  expect(await c.escrow.fundingPrefixEnd(c.ethers.ZeroAddress)).to.equal(0n);
}

describe("Uncapped participation and individual refund claims", function () {
  it("accepts 258 funders with interleaved top-ups and conserves every unit through individual partial refunds", async function () {
    this.timeout(60000);
    const c = await fixture({ target: 4096n, feeBps: 73, trancheBps: [3000, 7000] });
    const funders = [];
    let deposited = 0n;
    let maxDepositGas = 0n;
    async function contribute(funder, amount) {
      const receipt = await (await c.escrow.connect(funder.signer).deposit(amount)).wait();
      maxDepositGas = receipt.gasUsed > maxDepositGas ? receipt.gasUsed : maxDepositGas;
      funder.amount += amount;
      deposited += amount;
    }
    for (let i = 0; i < 257; i++) {
      const address = c.ethers.getAddress(`0x${(0x10000 + i).toString(16).padStart(40, "0")}`);
      await c.ethers.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]);
      await c.ethers.provider.send("hardhat_impersonateAccount", [address]);
      const signer = await c.ethers.getSigner(address);
      await c.token.mint(address, 1000n);
      await c.token.connect(signer).approve(c.escrowAddress, c.ethers.MaxUint256);
      const funder = { signer, amount: 0n };
      funders.push(funder);
      await contribute(funder, BigInt(10 + i % 7));
      // Exercise top-ups before later wallets and larger cumulative ranges exist.
      if (i > 0 && i % 17 === 0) await contribute(funders[Math.floor(i / 3)], BigInt(i % 5 + 1));
      if ((funders.length & (funders.length - 1)) === 0) await checkPrefixes(c, funders);
    }
    await contribute(funders[0], 7n);
    await contribute(funders[128], 9n);
    await contribute(funders[256], 11n);
    const last = { signer: c.alice, amount: 0n };
    funders.push(last);
    await contribute(last, c.target - deposited);
    await checkPrefixes(c, funders);

    const lock = await (await c.escrow.lockSelection(c.selectionId, c.solution.address)).wait();
    expect(lock.gasUsed).to.be.lessThan(400_000n);
    await c.escrow.connect(c.owner).approveSelection(c.selectionId);
    await c.escrow.connect(c.solution).approveSelection(c.selectionId);
    await c.escrow.release(c.selectionId);
    const pool = c.target - c.target * 3000n / 10000n;
    const fees = await c.escrow.feePaid();
    const beforeVoid = await c.token.balanceOf(c.escrowAddress);
    const voidReceipt = await (await c.escrow.connect(c.admin).voidEscrow(c.reason)).wait();
    expect(voidReceipt.gasUsed).to.be.lessThan(400_000n);
    expect(await c.token.balanceOf(c.escrowAddress)).to.equal(beforeVoid);
    expect(await c.escrow.totalRefunded()).to.equal(0n);

    let prefix = 0n;
    for (const funder of funders) {
      funder.refund = pool * (prefix + funder.amount) / c.target - pool * prefix / c.target;
      prefix += funder.amount;
      expect((await c.escrow.depositorSummary(funder.signer.address)).claimable).to.equal(funder.refund);
    }
    const claimOrder = [...funders.filter((_, i) => i % 2), ...funders.filter((_, i) => !(i % 2)).reverse()];
    let maxClaimGas = 0n;
    for (const funder of claimOrder) {
      const before = await c.token.balanceOf(funder.signer.address);
      const receipt = await (await c.escrow.connect(funder.signer).claimRefund()).wait();
      maxClaimGas = receipt.gasUsed > maxClaimGas ? receipt.gasUsed : maxClaimGas;
      expect(await c.token.balanceOf(funder.signer.address)).to.equal(before + funder.refund);
      expect(await c.escrow.refundedAmounts(funder.signer.address)).to.equal(funder.refund);
    }
    expect(maxDepositGas).to.be.lessThan(600_000n);
    expect(maxClaimGas).to.be.lessThan(400_000n);
    expect(await c.escrow.state()).to.equal(State.Refunded);
    expect(await c.escrow.totalRefunded()).to.equal(pool);
    expect(await c.escrow.feePaid()).to.equal(fees);
    expect(await c.token.balanceOf(c.escrowAddress)).to.equal(0n);
    await assertAccounting(c);
    console.log(`      258 funders: lock=${lock.gasUsed}, void=${voidReceipt.gasUsed}, max deposit=${maxDepositGas}, max claim=${maxClaimGas} gas`);
  });

  it("rolls back failed first deposits and top-ups without altering cumulative shares", async function () {
    const c = await fixture();
    const funders = [c.alice, c.bob, c.other].map((signer, i) => ({ signer, amount: BigInt(i + 1) * 100n }));
    for (const funder of funders) await c.escrow.connect(funder.signer).deposit(funder.amount);
    await c.token.mint(c.admin.address, 100n);
    await c.token.connect(c.admin).approve(c.escrowAddress, 100n);
    const anchors = await c.registry.fundingAnchorCount(c.proposalId);
    await c.token.configure(Behavior.RecipientFee, false);
    for (const signer of [c.admin, c.alice]) {
      await expect(c.escrow.connect(signer).deposit(20n)).to.be.revertedWithCustomError(c.escrow, "UnsupportedTokenBehavior");
      await checkPrefixes(c, funders);
      expect(await c.escrow.fundingPrefixEnd(c.admin.address)).to.equal(0n);
      expect(await c.registry.fundingAnchorCount(c.proposalId)).to.equal(anchors);
    }
    await c.token.configure(Behavior.Standard, false);
    await c.escrow.connect(c.admin).deposit(100n);
    funders.push({ signer: c.admin, amount: 100n });
    await c.escrow.connect(c.alice).deposit(300n);
    funders[0].amount += 300n;
    await checkPrefixes(c, funders);
    await c.escrow.connect(c.admin).voidEscrow(c.reason);
    for (const funder of funders.reverse()) await c.escrow.connect(funder.signer).claimRefund();
    expect(await c.escrow.totalRefunded()).to.equal(c.target);
    await assertAccounting(c);
  });

  it("keeps cumulative shares fixed across selection rejection and full refunds", async function () {
    const c = await fixture({ trancheBps: [5000, 5000] });
    await c.escrow.connect(c.alice).deposit(100n);
    await c.escrow.connect(c.bob).deposit(400n);
    await c.escrow.connect(c.alice).deposit(500n);
    const funders = [{ signer: c.alice, amount: 600n }, { signer: c.bob, amount: 400n }];
    await c.escrow.lockSelection(c.selectionId, c.solution.address);
    await c.escrow.invalidateSelection(c.selectionId, c.reason);
    await expect(c.escrow.connect(c.other).deposit(1n)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await checkPrefixes(c, funders);
    const next = c.ethers.id("replacement-selection");
    await expect(c.escrow.lockSelection(next, c.solution.address)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    expect((await c.escrow.depositorSummary(c.alice.address)).claimable).to.equal(600n);
    expect((await c.escrow.depositorSummary(c.bob.address)).claimable).to.equal(400n);
    await c.escrow.connect(c.bob).claimRefund();
    await c.escrow.connect(c.alice).claimRefund();
    await assertAccounting(c);
  });
});
