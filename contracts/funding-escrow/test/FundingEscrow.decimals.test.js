import { expect } from "chai";
import { fixture, createProposal, scopedId, approve, at, assertAccounting, State } from "./helpers.js";
import { parseTokenAmount, formatTokenAmount } from "../lib/tokenAmounts.js";

describe("FundingEscrow: token decimal policy and exact settlement", function () {
  for (const decimals of [0, 1, 2, 6, 8, 18, 24, 36, 77]) {
    it(`lists, snapshots and relists a ${decimals}-decimal token`, async function () {
      const c = await fixture({ decimals, target: 10n ** BigInt(Math.max(0, decimals - 2)) });
      expect(await c.factory.MAX_TOKEN_DECIMALS()).to.equal(77n);
      expect(await c.factory.tokenDecimals(c.tokenAddress)).to.equal(BigInt(decimals));
      expect(await c.escrow.tokenDecimals()).to.equal(BigInt(decimals));
      await expect(c.factory.connect(c.admin).setTokenAllowed(c.tokenAddress, false))
        .to.emit(c.factory, "TokenListingChanged").withArgs(c.tokenAddress, false, decimals);
      expect(await c.factory.tokenDecimals(c.tokenAddress)).to.equal(BigInt(decimals));
      await expect(c.factory.connect(c.admin).setTokenAllowed(c.tokenAddress, true))
        .to.emit(c.factory, "TokenListingChanged").withArgs(c.tokenAddress, true, decimals);
      const another = await c.ethers.deployContract("EscrowTestToken", [decimals]);
      await c.factory.connect(c.admin).setTokenAllowed(await another.getAddress(), true);
      expect(await c.factory.tokenDecimals(await another.getAddress())).to.equal(BigInt(decimals));
    });

    if (decimals < 77) {
      const unit = 10n ** BigInt(decimals);
      it(`refunds exact repeated whole-token contributions at ${decimals} decimals without fees`, async function () {
        const c = await fixture({ decimals, target: 1000n * unit, feeBps: 10000 });
        for (const amount of [unit, 37n * unit, 961n * unit]) await c.escrow.connect(c.alice).deposit(amount);
        await at(c, c.expiresAt);
        await c.escrow.connect(c.alice).claimRefund();
        const summary = await c.escrow.depositorSummary(c.alice.address);
        expect(summary.deposited).to.equal(999n * unit);
        expect(summary.depositCount).to.equal(3n);
        expect(summary.refunded).to.equal(999n * unit);
        expect(summary.claimable).to.equal(0n);
        expect(await c.escrow.feePaid()).to.equal(0n);
        expect(await c.token.balanceOf(c.alice.address)).to.equal(c.target * 10n);
        expect(parseTokenAmount(formatTokenAmount(summary.refunded, decimals), decimals)).to.equal(999n * unit);
        await assertAccounting(c);
      });
      const increment = 10n ** BigInt(Math.max(0, decimals - 2));
      for (const multiple of [999n, 1000n]) {
        const target = multiple * increment, fee = target * 10n / 10000n;
        it(`rounds the fee exactly on an allowed target at ${decimals} decimals (${multiple} increments)`, async function () {
          const c = await fixture({ decimals, target, feeBps: 10 }); await approve(c);
          await c.escrow.release(c.selectionId);
          expect(await c.token.balanceOf(c.admin.address)).to.equal(fee);
          expect(await c.token.balanceOf(c.solution.address)).to.equal(target - fee);
          expect(await c.escrow.feePaid()).to.equal(fee);
          expect(await c.escrow.totalReleased()).to.equal(target);
          await assertAccounting(c);
        });
      }
    }
  }

  for (const decimals of [0, 2, 6, 8, 18, 24, 36]) {
    it(`releases 1000 whole tokens with an exact 0.1% fee at ${decimals} decimals`, async function () {
      const target = parseTokenAmount("1000", decimals);
      const c = await fixture({ decimals, target, feeBps: 10 }); await approve(c);
      await c.escrow.release(c.selectionId);
      expect(formatTokenAmount(await c.token.balanceOf(c.admin.address), decimals)).to.equal("1");
      expect(formatTokenAmount(await c.token.balanceOf(c.solution.address), decimals)).to.equal("999");
      await assertAccounting(c);
    });
  }

  for (const decimals of [78, 255]) {
    it(`rejects ${decimals} decimals both at initial deployment and later listing`, async function () {
      const c = await fixture();
      const token = await c.ethers.deployContract("EscrowTestToken", [decimals]);
      const address = await token.getAddress();
      const Factory = await c.ethers.getContractFactory("FundingEscrowFactory");
      await expect(Factory.deploy(c.admin.address, c.platform.address, [address], 0, c.registryAddress))
        .to.be.revertedWithCustomError(c.factory, "UnsupportedTokenDecimals").withArgs(decimals);
      await expect(c.factory.connect(c.admin).setTokenAllowed(address, true))
        .to.be.revertedWithCustomError(c.factory, "UnsupportedTokenDecimals").withArgs(decimals);
      expect(await c.factory.allowedTokens(address)).to.equal(false);
      expect(await c.factory.getAllowedTokens()).to.deep.equal([c.tokenAddress]);
    });
  }

  for (const [label, response] of [["missing", 0], ["reverting", 1], ["short", 2], ["long", 3], ["out-of-uint8", 4]]) {
    it(`rejects ${label} decimals metadata without silently defaulting to 18`, async function () {
      const c = await fixture();
      const token = await c.ethers.deployContract("TokenMetadataFixture", [response]);
      const address = await token.getAddress();
      const error = response === 4 ? "UnsupportedTokenDecimals" : "InvalidTokenDecimals";
      const Factory = await c.ethers.getContractFactory("FundingEscrowFactory");
      await expect(Factory.deploy(c.admin.address, c.platform.address, [address], 0, c.registryAddress)).to.be.revertedWithCustomError(c.factory, error);
      await expect(c.factory.connect(c.admin).setTokenAllowed(address, true)).to.be.revertedWithCustomError(c.factory, error);
      expect(await c.factory.allowedTokens(address)).to.equal(false);
    });
  }

  for (const original of [0, 6]) {
    it(`blocks deposits, new escrows and relisting after a change from ${original} decimals`, async function () {
      const unit = 10n ** BigInt(original);
      const c = await fixture({ decimals: original, target: 1000n * unit });
      await c.escrow.connect(c.alice).deposit(10n * unit);
      await c.token.setDecimals(18);
      await expect(c.escrow.connect(c.alice).deposit(10n * unit)).to.be.revertedWithCustomError(c.escrow, "TokenDecimalsChanged").withArgs(original, 18);
      const next = scopedId(c, c.solution, "another-proposal");
      await expect(createProposal(c, "another-proposal"))
        .to.be.revertedWithCustomError(c.factory, "TokenDecimalsChanged").withArgs(original, 18);
      expect(await c.factory.escrowForProposal(next)).to.equal(c.ethers.ZeroAddress);
      await c.factory.connect(c.admin).setTokenAllowed(c.tokenAddress, false);
      await expect(c.factory.connect(c.admin).setTokenAllowed(c.tokenAddress, true))
        .to.be.revertedWithCustomError(c.factory, "TokenDecimalsChanged").withArgs(original, 18);
      expect(await c.factory.tokenDecimals(c.tokenAddress)).to.equal(BigInt(original));
      expect(await c.escrow.tokenDecimals()).to.equal(BigInt(original));
      expect(await c.escrow.contributions(c.alice.address)).to.equal(10n * unit);
      expect(await c.escrow.depositCounts(c.alice.address)).to.equal(1n);
      await c.token.setDecimals(original);
      await c.factory.connect(c.admin).setTokenAllowed(c.tokenAddress, true);
      await c.escrow.connect(c.alice).deposit(5n * unit);
      expect(await c.escrow.contributions(c.alice.address)).to.equal(15n * unit);
    });
  }

  it("rolls back a deposit if transferFrom changes the decimal metadata mid-transaction", async function () {
    const c = await fixture();
    await c.token.connect(c.alice).approve(c.escrowAddress, 50n);
    await c.token.setChangeDecimalsOnTransfer(true);
    await expect(c.escrow.connect(c.alice).deposit(50n)).to.be.revertedWithCustomError(c.escrow, "TokenDecimalsChanged").withArgs(0, 6);
    expect(await c.token.decimals()).to.equal(0n);
    expect(await c.token.balanceOf(c.alice.address)).to.equal(c.target * 10n);
    expect(await c.token.balanceOf(c.escrowAddress)).to.equal(0n);
    expect(await c.token.allowance(c.alice.address, c.escrowAddress)).to.equal(50n);
    expect(await c.escrow.contributions(c.alice.address)).to.equal(0n);
    expect(await c.escrow.totalDepositCount()).to.equal(0n);
    await c.token.setChangeDecimalsOnTransfer(false);
    await c.escrow.connect(c.alice).deposit(50n);
    await assertAccounting(c);
  });

  for (const metadataFailure of ["changed", "reverting", "unsupported"]) {
    for (const outcome of ["release", "refund"]) {
      it(`${metadataFailure} metadata blocks new risk but leaves ${outcome} available in original base units`, async function () {
        const c = await fixture({ feeBps: 10 });
        if (outcome === "release") await approve(c); else await c.escrow.connect(c.alice).deposit(500n);
        if (metadataFailure === "changed") await c.token.setDecimals(18);
        if (metadataFailure === "reverting") await c.token.setMetadataReverts(true);
        if (metadataFailure === "unsupported") await c.token.setDecimals(255);
        if (outcome === "refund") {
          const error = { changed: "TokenDecimalsChanged", reverting: "InvalidTokenDecimals", unsupported: "UnsupportedTokenDecimals" }[metadataFailure];
          await expect(c.escrow.connect(c.alice).deposit(1n)).to.be.revertedWithCustomError(c.escrow, error);
        }
        await c.factory.connect(c.admin).setTokenAllowed(c.tokenAddress, false);
        if (outcome === "release") {
          await c.escrow.release(c.selectionId);
          expect(await c.escrow.state()).to.equal(State.Released);
          expect(await c.token.balanceOf(c.solution.address)).to.equal(999n);
          expect(await c.token.balanceOf(c.admin.address)).to.equal(1n);
        } else {
          await at(c, c.expiresAt); await c.escrow.connect(c.alice).claimRefund();
          expect(await c.escrow.refundedAmounts(c.alice.address)).to.equal(500n);
        }
        expect(await c.escrow.tokenDecimals()).to.equal(0n);
        await assertAccounting(c);
      });
    }
  }
});
