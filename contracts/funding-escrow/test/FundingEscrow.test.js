import { expect } from "chai";
import { fixture, fund, lock, approve, at, mineAt, assertAccounting, State, Status } from "./helpers.js";

describe("FundingEscrow: deposits and dashboard history", function () {
  it("registers immutable posting, proposal, token and funding terms", async function () {
    const c = await fixture();
    expect(await c.escrow.postingId()).to.equal(c.postingId);
    expect(await c.escrow.proposalId()).to.equal(c.proposalId);
    expect(await c.escrow.token()).to.equal(c.tokenAddress);
    expect(await c.escrow.platformSigner()).to.equal(c.platform.address);
    expect(await c.escrow.problemOwner()).to.equal(c.owner.address);
    expect(await c.escrow.fundingTarget()).to.equal(c.target);
    expect(await c.escrow.expiresAt()).to.equal(c.expiresAt);
    expect(await c.escrow.state()).to.equal(State.Open);
    await expect(c.creation).to.emit(c.factory, "EscrowCreated").withArgs(
      c.postingId, c.proposalId, c.escrowAddress, c.owner.address, c.tokenAddress,
      c.target, c.expiresAt, c.admin.address, 0,
    );
  });

  it("preserves every top-up and cumulative contribution per depositor", async function () {
    const c = await fixture();
    for (const [amount, cumulative, number] of [[125n, 125n, 1n], [75n, 200n, 2n], [1n, 201n, 3n]]) {
      await expect(c.escrow.connect(c.alice).deposit(amount)).to.emit(c.escrow, "Deposited")
        .withArgs(c.postingId, c.proposalId, c.alice.address, c.tokenAddress, amount, cumulative, number);
    }
    await c.escrow.connect(c.bob).deposit(299n);
    const alice = await c.escrow.depositorSummary(c.alice.address);
    expect([...alice]).to.deep.equal([201n, 3n, 0n, 0n, 0n, Status.Locked]);
    expect(await c.escrow.contributions(c.bob.address)).to.equal(299n);
    expect(await c.escrow.totalDeposited()).to.equal(500n);
    expect(await c.escrow.totalDepositCount()).to.equal(4n);
    const history = await c.escrow.queryFilter(c.escrow.filters.Deposited(c.postingId, c.proposalId, c.alice.address));
    expect(history.map(log => log.args.amount)).to.deep.equal([125n, 75n, 1n]);
    await assertAccounting(c);
  });

  it("reports no contribution for an unrelated wallet", async function () {
    const c = await fixture();
    expect([...(await c.escrow.depositorSummary(c.other.address))]).to.deep.equal([0n, 0n, 0n, 0n, 0n, Status.None]);
  });

  for (const decimals of [6, 18]) {
    it(`uses exact base units for a ${decimals}-decimal token`, async function () {
      const c = await fixture({ decimals, target: 3n * 10n ** BigInt(decimals) });
      await c.escrow.connect(c.alice).deposit(101n * 10n ** BigInt(decimals - 2));
      await c.escrow.connect(c.alice).deposit(199n * 10n ** BigInt(decimals - 2));
      expect(await c.escrow.totalDeposited()).to.equal(c.target);
      await assertAccounting(c);
    });
  }

  it("rejects zero deposits without creating history", async function () {
    const c = await fixture();
    await expect(c.escrow.connect(c.alice).deposit(0)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    expect(await c.escrow.totalDepositCount()).to.equal(0n);
  });

  it("requires sufficient allowance and balance, with atomic rollback", async function () {
    const c = await fixture();
    await c.token.connect(c.alice).approve(c.escrowAddress, 99n);
    await expect(c.escrow.connect(c.alice).deposit(100n)).to.be.revertedWithCustomError(c.token, "ERC20InsufficientAllowance");
    await c.token.connect(c.owner).approve(c.escrowAddress, 100n);
    await expect(c.escrow.connect(c.owner).deposit(100n)).to.be.revertedWithCustomError(c.token, "ERC20InsufficientBalance");
    expect(await c.escrow.totalDeposited()).to.equal(0n);
    expect(await c.escrow.depositCounts(c.alice.address)).to.equal(0n);
    expect(await c.token.allowance(c.alice.address, c.escrowAddress)).to.equal(99n);
  });

  it("rejects over-funding rather than silently taking a smaller amount", async function () {
    const c = await fixture();
    await c.escrow.connect(c.alice).deposit(750n);
    await expect(c.escrow.connect(c.bob).deposit(251n)).to.be.revertedWithCustomError(c.escrow, "FundingTargetExceeded").withArgs(250n);
    expect(await c.escrow.contributions(c.bob.address)).to.equal(0n);
    await c.escrow.connect(c.bob).deposit(250n);
    await expect(c.escrow.connect(c.alice).deposit(1)).to.be.revertedWithCustomError(c.escrow, "FundingTargetExceeded").withArgs(0n);
    await assertAccounting(c);
  });

  it("accepts just before expiry and rejects at the exact expiry timestamp", async function () {
    const c = await fixture();
    await at(c, c.expiresAt - 1n);
    await c.escrow.connect(c.alice).deposit(10n);
    await at(c, c.expiresAt);
    await expect(c.escrow.connect(c.alice).deposit(10n)).to.be.revertedWithCustomError(c.escrow, "WindowClosed");
  });

  for (const closed of ["locked", "cancelled", "expired", "released", "refunded"]) {
    it(`rejects deposits when ${closed}`, async function () {
      const c = await fixture();
      if (closed === "locked") await lock(c);
      if (closed === "cancelled") await c.escrow.cancel(c.reason);
      if (closed === "expired") { await at(c, c.expiresAt); await c.escrow.expire(); }
      if (closed === "released") { await approve(c); await c.escrow.release(c.selectionId); }
      if (closed === "refunded") { await fund(c); await at(c, c.expiresAt); await c.escrow.connect(c.alice).claimRefund(); }
      await expect(c.escrow.connect(c.bob).deposit(1)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    });
  }

  it("rejects native ETH", async function () {
    const c = await fixture();
    await expect(c.alice.sendTransaction({ to: c.escrowAddress, value: 1n })).to.revert(c.ethers);
  });
});

describe("FundingEscrow: selection and dual approval", function () {
  it("cannot lock empty or partially funded proposals", async function () {
    const c = await fixture();
    await expect(c.escrow.lockSelection(c.selectionId, c.solution.address)).to.be.revertedWithCustomError(c.escrow, "FundingIncomplete");
    await c.escrow.connect(c.alice).deposit(999n);
    await expect(c.escrow.lockSelection(c.selectionId, c.solution.address)).to.be.revertedWithCustomError(c.escrow, "FundingIncomplete");
  });

  it("only the platform can lock; invalid recipients and selection IDs are rejected", async function () {
    const c = await fixture();
    await fund(c);
    await expect(c.escrow.connect(c.owner).lockSelection(c.selectionId, c.solution.address)).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    for (const recipient of [c.ethers.ZeroAddress, c.owner.address, c.escrowAddress]) {
      await expect(c.escrow.lockSelection(c.selectionId, recipient)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    }
    await expect(c.escrow.lockSelection(c.ethers.ZeroHash, c.solution.address)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
  });

  it("rejects locking at the posting deadline", async function () {
    const c = await fixture();
    await fund(c); await at(c, c.expiresAt);
    await expect(c.escrow.lockSelection(c.selectionId, c.solution.address)).to.be.revertedWithCustomError(c.escrow, "WindowClosed");
  });

  it("locks once and emits the seven-day approval deadline", async function () {
    const c = await fixture();
    await fund(c);
    const tx = await c.escrow.lockSelection(c.selectionId, c.solution.address);
    const receipt = await tx.wait();
    const block = await c.ethers.provider.getBlock(receipt.blockNumber);
    const deadline = BigInt(block.timestamp) + 7n * 86400n;
    await expect(tx).to.emit(c.escrow, "StateChanged").withArgs(State.Open, State.Locked);
    await expect(tx).to.emit(c.escrow, "SelectionLocked").withArgs(c.selectionId, c.solution.address, deadline);
    await expect(c.escrow.lockSelection(c.selectionId, c.solution.address)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
  });

  it("keeps the seven-day approval window when the posting expires sooner", async function () {
    const c = await fixture({ duration: 86400 });
    await lock(c);
    expect(await c.escrow.approvalDeadline()).to.equal(BigInt((await c.ethers.provider.getBlock("latest")).timestamp) + 7n * 86400n);
  });

  it("rejects approvals outside a locked selection and from unrelated wallets", async function () {
    const c = await fixture();
    await expect(c.escrow.connect(c.owner).approveSelection(c.selectionId)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await lock(c);
    for (const who of [c.platform, c.admin, c.alice]) {
      await expect(c.escrow.connect(who).approveSelection(c.selectionId)).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    }
    await expect(c.escrow.connect(c.owner).approveSelection(c.ethers.id("stale"))).to.be.revertedWithCustomError(c.escrow, "InvalidState");
  });

  for (const party of ["owner", "solution"]) {
    it(`requires the other approval when ${party} approves first, and prevents duplicate approval`, async function () {
      const c = await fixture(); await lock(c);
      await expect(c.escrow.release(c.selectionId)).to.be.revertedWithCustomError(c.escrow, "ApprovalIncomplete");
      await expect(c.escrow.connect(c[party]).approveSelection(c.selectionId)).to.emit(c.escrow, "SelectionApproved").withArgs(c.selectionId, c[party].address);
      await expect(c.escrow.connect(c[party]).approveSelection(c.selectionId)).to.be.revertedWithCustomError(c.escrow, "AlreadyApproved");
      await expect(c.escrow.release(c.selectionId)).to.be.revertedWithCustomError(c.escrow, "ApprovalIncomplete");
      await c.escrow.connect(c[party === "owner" ? "solution" : "owner"]).approveSelection(c.selectionId);
      await c.escrow.release(c.selectionId);
      expect(await c.token.balanceOf(c.solution.address)).to.equal(c.target);
    });
  }

  it("only the platform can release, and it releases once with complete historical accounting", async function () {
    const c = await fixture(); await approve(c);
    for (const who of [c.owner, c.solution, c.admin, c.alice]) {
      await expect(c.escrow.connect(who).release(c.selectionId)).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    }
    await expect(c.escrow.release(c.ethers.id("wrong-selection"))).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await expect(c.escrow.release(c.selectionId)).to.emit(c.escrow, "Released")
      .withArgs(c.selectionId, c.solution.address, c.target, c.target);
    expect(await c.escrow.state()).to.equal(State.Released);
    expect([...(await c.escrow.depositorSummary(c.alice.address))]).to.deep.equal([c.target, 1n, 0n, 0n, c.target, Status.Released]);
    await expect(c.escrow.release(c.selectionId)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await expect(c.escrow.cancel(c.reason)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await at(c, c.expiresAt);
    await expect(c.escrow.connect(c.alice).claimRefund()).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    expect((await c.escrow.depositorSummary(c.alice.address)).status).to.equal(Status.Released);
    await assertAccounting(c);
  });

  it("rejects approvals and release at the exact approval deadline", async function () {
    const c = await fixture(); await approve(c);
    await at(c, await c.escrow.approvalDeadline());
    await expect(c.escrow.release(c.selectionId)).to.be.revertedWithCustomError(c.escrow, "WindowClosed");
    await expect(c.escrow.connect(c.owner).approveSelection(c.selectionId)).to.be.revertedWithCustomError(c.escrow, "WindowClosed");
    await at(c, c.expiresAt);
    await c.escrow.connect(c.alice).claimRefund();
    expect(await c.escrow.state()).to.equal(State.Refunded);
  });

  it("allows release in the last second of the approval window", async function () {
    const c = await fixture(); await approve(c);
    await at(c, (await c.escrow.approvalDeadline()) - 1n);
    await c.escrow.release(c.selectionId);
    await assertAccounting(c);
  });

  it("invalidation clears both approvals and permanently refunds the rejected selection", async function () {
    const c = await fixture(); await approve(c);
    await expect(c.escrow.connect(c.other).invalidateSelection(c.selectionId, c.reason)).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    await expect(c.escrow.invalidateSelection(c.selectionId, c.ethers.ZeroHash)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    await expect(c.escrow.invalidateSelection(c.ethers.id("wrong"), c.reason)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await expect(c.escrow.invalidateSelection(c.selectionId, c.reason)).to.emit(c.escrow, "SelectionInvalidated").withArgs(c.selectionId, c.reason);
    expect(await c.escrow.state()).to.equal(State.Cancelled);
    expect(await c.escrow.ownerApproved()).to.equal(false);
    expect(await c.escrow.solutionApproved()).to.equal(false);
    expect(await c.escrow.solutionOwner()).to.equal(c.ethers.ZeroAddress);
    expect(await c.escrow.approvalDeadline()).to.equal(0n);
    await expect(c.escrow.lockSelection(c.selectionId, c.solution.address)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    const next = c.ethers.id("selection-2");
    await expect(c.escrow.lockSelection(next, c.solution.address)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await expect(c.escrow.release(c.selectionId)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await expect(c.escrow.release(next)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    expect((await c.escrow.depositorSummary(c.alice.address)).claimable).to.equal(c.target);
    await c.escrow.connect(c.alice).claimRefund();
    expect(await c.registry.pendingProposalForPosting(c.postingId)).to.equal(c.ethers.ZeroHash);
    await assertAccounting(c);
  });

  it("invalidation after posting expiry cannot reopen funding", async function () {
    const c = await fixture(); await lock(c); await at(c, c.expiresAt);
    await c.escrow.invalidateSelection(c.selectionId, c.reason);
    expect(await c.escrow.state()).to.equal(State.Cancelled);
    await c.escrow.connect(c.alice).claimRefund();
  });
});

describe("FundingEscrow: cancellation, expiry and pull refunds", function () {
  for (const phase of ["open", "locked", "cancelled"]) {
    it(`prevents early refunds while ${phase}`, async function () {
      const c = await fixture();
      if (phase === "locked") await lock(c); else await fund(c);
      if (phase === "cancelled") await c.escrow.cancel(c.reason);
      await at(c, (phase === "locked" ? await c.escrow.approvalDeadline() : c.expiresAt) - 1n);
      await expect(c.escrow.connect(c.alice).claimRefund()).to.be.revertedWithCustomError(c.escrow, "WindowStillOpen");
    });
  }

  it("only the platform can cancel, with a nonzero evidence hash", async function () {
    const c = await fixture(); await approve(c);
    await expect(c.escrow.connect(c.owner).cancel(c.reason)).to.be.revertedWithCustomError(c.escrow, "AccessDenied");
    await expect(c.escrow.cancel(c.ethers.ZeroHash)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    await expect(c.escrow.cancel(c.reason)).to.emit(c.escrow, "Cancelled").withArgs(c.reason);
    expect((await c.escrow.depositorSummary(c.alice.address)).status).to.equal(Status.RefundPending);
    await expect(c.escrow.release(c.selectionId)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await expect(c.escrow.cancel(c.reason)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await at(c, c.expiresAt);
    await c.escrow.connect(c.alice).claimRefund();
    expect(await c.escrow.state()).to.equal(State.Refunded);
  });

  it("supports permissionless expiry exactly at the boundary, including empty pools", async function () {
    const c = await fixture();
    await expect(c.escrow.connect(c.other).expire()).to.be.revertedWithCustomError(c.escrow, "WindowStillOpen");
    await at(c, c.expiresAt);
    await expect(c.escrow.connect(c.other).expire()).to.emit(c.escrow, "StateChanged").withArgs(State.Open, State.Expired);
    await expect(c.escrow.expire()).to.be.revertedWithCustomError(c.escrow, "InvalidState");
    await expect(c.escrow.connect(c.other).claimRefund()).to.be.revertedWithCustomError(c.escrow, "NothingToRefund");
  });

  for (const phase of ["open", "locked", "expired", "cancelled"]) {
    it(`refunds exact pooled top-ups from ${phase}, retaining dashboard history`, async function () {
      const c = await fixture();
      await c.escrow.connect(c.alice).deposit(100n);
      await c.escrow.connect(c.alice).deposit(200n);
      await c.escrow.connect(c.bob).deposit(phase === "locked" ? 700n : 400n);
      if (phase === "locked") await c.escrow.lockSelection(c.selectionId, c.solution.address);
      if (phase === "cancelled") await c.escrow.cancel(c.reason);
      await mineAt(c, c.expiresAt);
      if (phase === "expired") await c.escrow.expire();
      const before = await c.escrow.depositorSummary(c.alice.address);
      expect([...before]).to.deep.equal([300n, 2n, 0n, 300n, 0n, Status.Refundable]);
      await expect(c.escrow.connect(c.other).claimRefund()).to.be.revertedWithCustomError(c.escrow, "NothingToRefund");
      const balance = await c.token.balanceOf(c.alice.address);
      await expect(c.escrow.connect(c.alice).claimRefund()).to.emit(c.escrow, "RefundClaimed").withArgs(c.alice.address, 300n, 300n);
      expect(await c.token.balanceOf(c.alice.address)).to.equal(balance + 300n);
      expect([...(await c.escrow.depositorSummary(c.alice.address))]).to.deep.equal([300n, 2n, 300n, 0n, 0n, Status.Refunded]);
      expect((await c.escrow.depositorSummary(c.bob.address)).status).to.equal(Status.Refundable);
      await expect(c.escrow.connect(c.alice).claimRefund()).to.be.revertedWithCustomError(c.escrow, "NothingToRefund");
      await c.escrow.connect(c.bob).claimRefund();
      expect(await c.escrow.state()).to.equal(State.Refunded);
      expect(await c.escrow.totalRefunded()).to.equal(await c.escrow.totalDeposited());
      expect(await c.escrow.contributions(c.alice.address)).to.equal(300n);
      await expect(c.escrow.connect(c.bob).claimRefund()).to.be.revertedWithCustomError(c.escrow, "InvalidState");
      await expect(c.escrow.release(c.selectionId)).to.be.revertedWithCustomError(c.escrow, "InvalidState");
      await assertAccounting(c);
    });
  }

  it("does not credit unsolicited token transfers or sweep them into releases", async function () {
    const c = await fixture();
    await c.token.connect(c.bob).transfer(c.escrowAddress, 15n);
    expect(await c.escrow.totalDeposited()).to.equal(0n);
    await approve(c); await c.escrow.release(c.selectionId);
    expect(await c.token.balanceOf(c.solution.address)).to.equal(c.target);
    expect(await c.token.balanceOf(c.escrowAddress)).to.equal(15n);
    expect((await c.escrow.depositorSummary(c.bob.address)).status).to.equal(Status.None);
    await assertAccounting(c);
  });
});
