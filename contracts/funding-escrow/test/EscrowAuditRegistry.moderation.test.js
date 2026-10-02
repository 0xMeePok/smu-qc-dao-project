import { expect } from "chai";
import { fixture, assertAccounting } from "./helpers.js";

function decision(c, label = "comment-remove") {
  const record = {
    eventVersion: 1, actorId: c.admin.address, action: "remove", contentType: "comment",
    contentId: "firestore-comment", reason: "spam", createdAt: "2026-10-02T00:00:00.000Z",
    salt: c.ethers.hexlify(c.ethers.randomBytes(32)),
  };
  return { id: c.ethers.id(label), hash: c.ethers.keccak256(c.ethers.toUtf8Bytes(JSON.stringify(record))) };
}

describe("QCDAO-90 private moderation audit commitments", function () {
  it("anchors an opaque comment decision with the submitter and block time, without a registry entity", async function () {
    const c = await fixture(); const d = decision(c);
    expect(await c.registry.moderationRecordHash(d.id)).to.equal(c.ethers.ZeroHash);
    const tx = await c.registry.anchorModeration(d.id, d.hash); const receipt = await tx.wait();
    const block = await c.ethers.provider.getBlock(receipt.blockNumber);
    await expect(tx).to.emit(c.registry, "ModerationAnchored")
      .withArgs(d.id, d.hash, c.platform.address, BigInt(block.timestamp));
    expect(await c.registry.moderationRecordHash(d.id)).to.equal(d.hash);
    const parsed = c.registry.interface.parseTransaction({ data: tx.data });
    expect([...parsed.args]).to.deep.equal([d.id, d.hash]);
    expect(c.registry.interface.getFunction("anchorModeration").inputs.map(input => input.type))
      .to.deep.equal(["bytes32", "bytes32"]);
  });

  it("allows the owner and an explicitly delegated admin to anchor before factory wiring", async function () {
    const c = await fixture(); const d = decision(c);
    const fresh = await c.ethers.deployContract("EscrowAuditRegistry", [c.admin.address]);
    await fresh.connect(c.admin).anchorModeration(d.id, d.hash);
    await fresh.connect(c.admin).setModerationAdmin(c.other.address, true);
    await fresh.connect(c.other).anchorModeration(c.ethers.id("pre-wiring-delegate"), d.hash);
    await expect(fresh.connect(c.platform).anchorModeration(c.ethers.id("unconfigured-platform"), d.hash))
      .to.be.revertedWithCustomError(fresh, "AccessDenied");
  });

  for (const who of ["owner", "solution", "alice", "other"]) {
    it(`rejects an unlisted ${who} wallet`, async function () {
      const c = await fixture(); const d = decision(c);
      await expect(c.registry.connect(c[who]).anchorModeration(d.id, d.hash))
        .to.be.revertedWithCustomError(c.registry, "AccessDenied");
      expect(await c.registry.moderationRecordHash(d.id)).to.equal(c.ethers.ZeroHash);
    });
  }

  it("does not implicitly authorize a factory escrow admin to anchor moderation", async function () {
    const c = await fixture(); const d = decision(c);
    await c.factory.connect(c.admin).setEscrowAdmin(c.other.address, true);
    await expect(c.registry.connect(c.other).anchorModeration(d.id, d.hash))
      .to.be.revertedWithCustomError(c.registry, "AccessDenied");
  });

  it("only lets the registry owner grant or revoke moderation admins", async function () {
    const c = await fixture();
    await expect(c.registry.connect(c.other).setModerationAdmin(c.other.address, true))
      .to.be.revertedWithCustomError(c.registry, "OwnableUnauthorizedAccount").withArgs(c.other.address);
    await expect(c.registry.connect(c.admin).setModerationAdmin(c.other.address, true))
      .to.emit(c.registry, "ModerationAdminChanged").withArgs(c.other.address, true);
    expect(await c.registry.isModerationAdmin(c.other.address)).to.equal(true);
    await expect(c.registry.connect(c.other).setModerationAdmin(c.alice.address, true))
      .to.be.revertedWithCustomError(c.registry, "OwnableUnauthorizedAccount");
    await expect(c.registry.connect(c.platform).setModerationAdmin(c.other.address, false))
      .to.be.revertedWithCustomError(c.registry, "OwnableUnauthorizedAccount");
  });

  it("revokes delegated anchoring immediately without deleting previous commitments", async function () {
    const c = await fixture(); const d = decision(c);
    await c.registry.connect(c.admin).setModerationAdmin(c.other.address, true);
    await c.registry.connect(c.other).anchorModeration(d.id, d.hash);
    await expect(c.registry.connect(c.admin).setModerationAdmin(c.other.address, false))
      .to.emit(c.registry, "ModerationAdminChanged").withArgs(c.other.address, false);
    expect(await c.registry.isModerationAdmin(c.other.address)).to.equal(false);
    await expect(c.registry.connect(c.other).anchorModeration(c.ethers.id("after-revocation"), d.hash))
      .to.be.revertedWithCustomError(c.registry, "AccessDenied");
    expect(await c.registry.moderationRecordHash(d.id)).to.equal(d.hash);
  });

  it("automatically grants the configured platform signer a genuinely revocable role", async function () {
    const c = await fixture(); const d = decision(c);
    expect(await c.registry.isModerationAdmin(c.platform.address)).to.equal(true);
    await c.registry.anchorModeration(d.id, d.hash);
    await c.registry.connect(c.admin).setModerationAdmin(c.platform.address, false);
    expect(await c.registry.isModerationAdmin(c.platform.address)).to.equal(false);
    await expect(c.registry.anchorModeration(c.ethers.id("revoked-platform"), d.hash))
      .to.be.revertedWithCustomError(c.registry, "AccessDenied");
    await c.registry.connect(c.admin).setModerationAdmin(c.platform.address, true);
    await c.registry.anchorModeration(c.ethers.id("restored-platform"), d.hash);
  });

  it("rejects zero admin addresses, decision IDs and record hashes", async function () {
    const c = await fixture(); const d = decision(c);
    for (const enabled of [true, false]) await expect(c.registry.connect(c.admin)
      .setModerationAdmin(c.ethers.ZeroAddress, enabled)).to.be.revertedWithCustomError(c.registry, "InvalidInput");
    expect(await c.registry.isModerationAdmin(c.ethers.ZeroAddress)).to.equal(false);
    await expect(c.registry.anchorModeration(c.ethers.ZeroHash, d.hash))
      .to.be.revertedWithCustomError(c.registry, "InvalidInput");
    await expect(c.registry.anchorModeration(d.id, c.ethers.ZeroHash))
      .to.be.revertedWithCustomError(c.registry, "InvalidInput");
  });

  it("rejects identical retries and conflicting overwrites while preserving the original proof", async function () {
    const c = await fixture(); const d = decision(c);
    await c.registry.anchorModeration(d.id, d.hash);
    for (const hash of [d.hash, c.ethers.id("changed decision")]) {
      await expect(c.registry.connect(c.admin).anchorModeration(d.id, hash))
        .to.be.revertedWithCustomError(c.registry, "InvalidState");
    }
    expect(await c.registry.moderationRecordHash(d.id)).to.equal(d.hash);
    expect(await c.registry.queryFilter(c.registry.filters.ModerationAnchored(d.id))).to.have.length(1);
    await c.registry.anchorModeration(c.ethers.id("distinct-decision"), d.hash);
  });

  it("keeps moderation commitments separate from proposal revisions, funding state and custody", async function () {
    const c = await fixture(); const d = decision(c);
    await c.escrow.connect(c.alice).deposit(100n);
    const proposal = await c.registry.getProposal(c.proposalId);
    const opportunity = await c.registry.getOpportunity(c.postingId);
    const auditCount = await c.registry.anchorCount(c.proposalId);
    const fundingCount = await c.registry.fundingAnchorCount(c.proposalId);
    await c.registry.anchorModeration(c.proposalId, d.hash);
    expect(await c.registry.getProposal(c.proposalId)).to.deep.equal(proposal);
    expect(await c.registry.getOpportunity(c.postingId)).to.deep.equal(opportunity);
    expect(await c.registry.anchorCount(c.proposalId)).to.equal(auditCount);
    expect(await c.registry.fundingAnchorCount(c.proposalId)).to.equal(fundingCount);
    expect(await c.registry.postingFundingPaused(c.postingId)).to.equal(false);
    expect(await c.registry.pendingProposalForPosting(c.postingId)).to.equal(c.ethers.ZeroHash);
    expect(await c.registry.acceptedProposalForPosting(c.postingId)).to.equal(c.ethers.ZeroHash);
    expect(await c.registry.isFundingActive(c.proposalId, c.escrowAddress)).to.equal(true);
    expect(await c.escrow.totalDeposited()).to.equal(100n);
    await assertAccounting(c);
  });

  it("can anchor a removal after the content is withdrawn", async function () {
    const c = await fixture(); const d = decision(c);
    await c.registry.connect(c.owner).withdrawOpportunity(c.postingId, c.reason);
    await c.registry.anchorModeration(d.id, d.hash);
    expect(await c.registry.moderationRecordHash(d.id)).to.equal(d.hash);
  });

  it("moves implicit admin authority only when the two-step ownership transfer is accepted", async function () {
    const c = await fixture(); const d = decision(c);
    await c.registry.connect(c.admin).transferOwnership(c.other.address);
    expect(await c.registry.isModerationAdmin(c.other.address)).to.equal(false);
    await expect(c.registry.connect(c.other).setModerationAdmin(c.alice.address, true))
      .to.be.revertedWithCustomError(c.registry, "OwnableUnauthorizedAccount");
    await c.registry.connect(c.other).acceptOwnership();
    expect(await c.registry.isModerationAdmin(c.other.address)).to.equal(true);
    expect(await c.registry.isModerationAdmin(c.admin.address)).to.equal(false);
    await expect(c.registry.connect(c.admin).anchorModeration(d.id, d.hash))
      .to.be.revertedWithCustomError(c.registry, "AccessDenied");
    await c.registry.connect(c.other).anchorModeration(d.id, d.hash);
    await c.registry.connect(c.other).setModerationAdmin(c.alice.address, true);
  });

  it("preserves explicit delegation across an ownership transfer until the new owner revokes it", async function () {
    const c = await fixture(); const d = decision(c);
    await c.registry.connect(c.admin).setModerationAdmin(c.admin.address, true);
    await c.registry.connect(c.admin).transferOwnership(c.other.address);
    await c.registry.connect(c.other).acceptOwnership();
    expect(await c.registry.isModerationAdmin(c.admin.address)).to.equal(true);
    await c.registry.connect(c.admin).anchorModeration(d.id, d.hash);
    await c.registry.connect(c.other).setModerationAdmin(c.admin.address, false);
    expect(await c.registry.isModerationAdmin(c.admin.address)).to.equal(false);
  });
});
