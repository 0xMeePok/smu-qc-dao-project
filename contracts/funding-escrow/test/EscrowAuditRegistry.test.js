import { expect } from "chai";
import { fixture, createProposal, scopedId, terms, at, assertAccounting, State } from "./helpers.js";
import { first, submit, approveLater } from "./milestoneHelpers.js";

describe("Atomic audit registry and escrow integration", function () {
  it("derives both owners from the registry and atomically creates an audited canonical escrow", async function () {
    const c = await fixture({ trancheBps: [2500, 7500], funderVoting: true });
    expect(await c.registry.proposalEscrow(c.proposalId)).to.equal(c.escrowAddress);
    expect(await c.registry.fundingFactory()).to.equal(await c.factory.getAddress());
    expect(await c.factory.auditRegistry()).to.equal(c.registryAddress);
    expect(await c.escrow.problemOwner()).to.equal(c.owner.address);
    expect(await c.escrow.proposalOwner()).to.equal(c.solution.address);
    expect(await c.escrow.auditRegistry()).to.equal(c.registryAddress);
    expect(await c.escrow.funderVoting()).to.equal(true);
    expect(await c.registry.isFundingActive(c.proposalId, c.escrowAddress)).to.equal(true);
    expect(await c.registry.isFundingActive(c.proposalId, c.other.address)).to.equal(false);
    expect(await c.registry.isFundingActive(c.proposalId, c.ethers.ZeroAddress)).to.equal(false);
    const anchor = await c.registry.fundingAnchorAt(c.proposalId, 0);
    expect(anchor.eventType).to.equal(0n); expect(anchor.actor).to.equal(c.solution.address);
    expect(anchor.digest).to.equal(c.ethers.keccak256(c.ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(address token,uint256 target,bool funderVoting,uint16[] trancheBps,uint64[] reviewWindows,bytes32[] milestoneHashes)"],
      [terms(c, { trancheBps: [2500, 7500], funderVoting: true })])));
  });
  it("disables legacy unlinked creation and prevents forged audit events", async function () {
    const c = await fixture();
    await expect(c.registry.connect(c.solution).commitProposal(c.proposalId, c.postingId, c.reason, c.reason, 0))
      .to.be.revertedWithCustomError(c.registry, "FundingTermsRequired");
    await expect(c.registry.recordFundingEvent(c.proposalId, 1, c.reason, c.alice.address))
      .to.be.revertedWithCustomError(c.registry, "AccessDenied");
    await expect(c.factory.createEscrow(c.proposalId, terms(c))).to.be.revertedWithCustomError(c.factory, "AccessDenied");
  });
  it("wires the registry once, only by its owner, with a matching factory", async function () {
    const c = await fixture();
    const fresh = await c.ethers.deployContract("EscrowAuditRegistry", [c.admin.address]);
    await expect(fresh.connect(c.other).setFundingFactory(await c.factory.getAddress())).to.be.revertedWithCustomError(fresh, "OwnableUnauthorizedAccount");
    await expect(fresh.connect(c.admin).setFundingFactory(c.other.address)).to.be.revertedWithCustomError(fresh, "InvalidInput");
    await expect(fresh.connect(c.admin).setFundingFactory(await c.factory.getAddress())).to.be.revertedWithCustomError(fresh, "InvalidInput");
    await expect(c.registry.connect(c.admin).setFundingFactory(await c.factory.getAddress())).to.be.revertedWithCustomError(c.registry, "InvalidInput");
    await expect(fresh.commitProposalWithEscrow(c.proposalId, c.postingId, c.reason, c.reason, 0, terms(c)))
      .to.be.revertedWithCustomError(fresh, "InvalidState");
    const Factory = await c.ethers.getContractFactory("FundingEscrowFactory");
    await expect(Factory.deploy(c.admin.address, c.platform.address, [c.tokenAddress], 0, c.other.address))
      .to.be.revertedWithCustomError(c.factory, "InvalidInput");
  });
  it("rejects mismatched actor IDs, overlapping approval roles and withdrawn postings", async function () {
    const c = await fixture();
    await expect(c.registry.connect(c.other).commitProposalWithEscrow(scopedId(c, c.solution, "bad"), c.postingId, c.reason, c.reason, 0, terms(c)))
      .to.be.revertedWithCustomError(c.registry, "AccessDenied");
    await expect(createProposal(c, "self", {}, c.owner)).to.be.revertedWithCustomError(c.escrow, "InvalidInput");
    await c.registry.connect(c.owner).withdrawOpportunity(c.postingId, c.reason);
    await expect(createProposal(c, "closed")).to.be.revertedWithCustomError(c.registry, "InvalidState");
  });
  it("requires a finite future funding deadline", async function () {
    const c = await fixture(); const id = scopedId(c, c.owner, "no-expiry");
    await c.registry.connect(c.owner).commitOpportunity(id, 0, c.reason, 0);
    await expect(createProposal({ ...c, postingId: id }, "no-expiry-proposal")).to.be.revertedWithCustomError(c.factory, "InvalidInput");
    await at(c, c.expiresAt);
    await expect(createProposal(c, "expired")).to.be.revertedWithCustomError(c.registry, "InvalidState");
  });
  it("freezes proposal and parent content after funding; the deadline stays immutable", async function () {
    const c = await fixture();
    await c.registry.connect(c.solution).updateHashes(c.proposalId, c.reason, c.reason, 0);
    await expect(c.registry.connect(c.owner).updateOpportunity(c.postingId, c.reason, c.expiresAt + 1n))
      .to.be.revertedWithCustomError(c.registry, "FundingTermsFrozen");
    await c.escrow.connect(c.alice).deposit(1n);
    await expect(c.registry.connect(c.solution).updateHashes(c.proposalId, c.reason, c.reason, 0))
      .to.be.revertedWithCustomError(c.registry, "FundingTermsFrozen");
    await expect(c.registry.connect(c.owner).updateOpportunity(c.postingId, c.reason, c.expiresAt))
      .to.be.revertedWithCustomError(c.registry, "FundingTermsFrozen");
    await c.escrow.connect(c.admin).voidEscrow(c.reason);
    await expect(c.registry.connect(c.solution).updateHashes(c.proposalId, c.reason, c.reason, 0))
      .to.be.revertedWithCustomError(c.registry, "InvalidState");
  });
  for (const kind of ["proposal", "posting"]) for (const phase of ["open", "active"]) {
    it(`${kind} withdrawal in ${phase} stops funding/payments and permits anyone to open refunds`, async function () {
      const c = await fixture({ trancheBps: [4000, 6000] });
      if (phase === "active") await first(c); else await c.escrow.connect(c.alice).deposit(200n);
      const args = phase === "active" ? await submit(c) : undefined;
      if (args) await approveLater(c, args);
      if (kind === "proposal") await c.registry.connect(c.solution).withdrawProposal(c.proposalId, c.reason);
      else await c.registry.connect(c.owner).withdrawOpportunity(c.postingId, c.reason);
      expect(await c.registry.isFundingActive(c.proposalId, c.escrowAddress)).to.equal(false);
      if (args) await expect(c.escrow.releaseMilestone(...args)).to.be.revertedWithCustomError(c.escrow, "WorkflowInactive");
      else await expect(c.escrow.connect(c.alice).deposit(1n)).to.be.revertedWithCustomError(c.escrow, "WorkflowInactive");
      await c.escrow.connect(c.other).refundInvalidated();
      expect(await c.escrow.state()).to.equal(State.Voided);
      await expect(c.escrow.refundInvalidated()).to.be.revertedWithCustomError(c.escrow, "InvalidState");
      await c.escrow.connect(c.alice).claimRefund();
      expect(await c.escrow.totalRefunded()).to.equal(phase === "active" ? 600n : 200n);
      await assertAccounting(c);
    });
  }
  it("rejects refund synchronization while the linked proposal is active", async function () {
    const c = await fixture();
    await expect(c.escrow.refundInvalidated()).to.be.revertedWithCustomError(c.escrow, "InvalidState");
  });
  it("anchors funding actions under the correct proposal", async function () {
    const c = await fixture({ trancheBps: [5000, 5000], funderVoting: true }); await first(c);
    const args = await submit(c); await approveLater(c, args);
    await c.escrow.connect(c.alice).voteMilestone(args[1], args[2], true);
    await c.escrow.connect(c.admin).voidEscrow(c.reason); await c.escrow.connect(c.alice).claimRefund();
    const events = await c.registry.queryFilter(c.registry.filters.FundingEventAnchored(c.proposalId));
    expect(events.map(e => e.args.eventType)).to.deep.equal([0n, 1n, 2n, 3n, 3n, 8n, 7n, 3n, 3n, 11n, 9n, 10n]);
    expect(await c.registry.fundingAnchorCount(c.proposalId)).to.equal(BigInt(events.length));
    for (const event of events) expect(event.args.escrow).to.equal(c.escrowAddress);
  });
});
