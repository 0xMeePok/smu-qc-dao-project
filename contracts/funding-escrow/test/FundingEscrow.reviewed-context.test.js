import { expect } from "chai";
import { fixture } from "./helpers.js";

describe("FundingEscrow: reviewed first-deposit context", function () {
  it("rejects amount-only first deposits before freezing or transferring custody", async function () {
    const c = await fixture();
    await c.registry.connect(c.solution).updateHashes(c.proposalId, c.ethers.id("changed proposal"), c.ethers.id("changed solution"), 0);
    await expect(c.escrow.connect(c.alice).deposit(100n)).to.revert(c.ethers);
    expect(await c.escrow.totalDeposited()).to.equal(0n);
    expect(await c.registry.postingFundingStarted(c.postingId)).to.equal(false);
    expect(await c.token.balanceOf(c.escrowAddress)).to.equal(0n);
  });

  for (const changed of ["proposal", "parent", "parent-and-rebound-proposal"]) {
    it(`rejects a reviewed deposit after ${changed} changes without freezing or taking funds`, async function () {
      const c = await fixture();
      const reviewed = await c.registry.fundingContextDigest(c.proposalId);
      if (changed !== "proposal") await c.registry.connect(c.owner).updateOpportunity(c.postingId, c.ethers.id("amended parent"), c.expiresAt);
      if (changed !== "parent") await c.registry.connect(c.solution).updateHashes(c.proposalId,
        c.ethers.id("amended proposal"), c.ethers.id("amended solution"), changed === "proposal" ? 0 : 1);
      await expect(c.escrow.connect(c.alice).depositReviewed(100n, reviewed)).to.revert(c.ethers);
      expect(await c.escrow.totalDeposited()).to.equal(0n);
      expect(await c.registry.postingFundingStarted(c.postingId)).to.equal(false);
      expect(await c.token.balanceOf(c.escrowAddress)).to.equal(0n);
    });
  }

  it("matches the explicit client encoding and permits reviewed funding plus frozen legacy top-ups", async function () {
    const c = await fixture();
    const proposal = await c.registry.getProposal(c.proposalId), parent = await c.registry.getOpportunity(c.postingId);
    const digest = c.ethers.keccak256(c.ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "bytes32", "uint256", "bytes32", "bytes32", "bytes32", "uint32", "bytes32", "uint256", "bytes32", "bytes32"],
      [c.registryAddress, (await c.ethers.provider.getNetwork()).chainId, c.proposalId, 1n,
        proposal.proposalHash, proposal.solutionHash, c.postingId, 0, proposal.opportunityRevisionDigest, 1n, parent.contentHash, parent.contentHash]));
    expect(await c.registry.fundingContextDigest(c.proposalId)).to.equal(digest);
    await c.escrow.connect(c.alice).depositReviewed(100n, digest);
    await c.escrow.connect(c.bob).deposit(100n);
    expect(await c.escrow.totalDeposited()).to.equal(200n);
    await expect(c.registry.connect(c.owner).updateOpportunity(c.postingId, c.ethers.id("late parent"), c.expiresAt))
      .to.be.revertedWithCustomError(c.registry, "FundingTermsFrozen");
    await expect(c.registry.connect(c.solution).updateHashes(c.proposalId, c.ethers.id("late proposal"), c.ethers.id("late solution"), 0))
      .to.be.revertedWithCustomError(c.registry, "FundingTermsFrozen");
  });

  it("permits a newly reviewed explicit parent rebind and preserves expiry refunds", async function () {
    const c = await fixture();
    await c.registry.connect(c.owner).updateOpportunity(c.postingId, c.ethers.id("reviewed parent amendment"), c.expiresAt);
    await c.registry.connect(c.solution).updateHashes(c.proposalId, c.ethers.id("reviewed proposal amendment"), c.ethers.id("reviewed solution amendment"), 1);
    await c.escrow.connect(c.alice).depositReviewed(100n, await c.registry.fundingContextDigest(c.proposalId));
    await c.ethers.provider.send("evm_setNextBlockTimestamp", [Number(c.expiresAt)]);
    await c.escrow.connect(c.alice).claimRefund();
    expect(await c.escrow.refundedAmounts(c.alice.address)).to.equal(100n);
    expect(await c.escrow.totalDeposited()).to.equal(100n);
  });
});
