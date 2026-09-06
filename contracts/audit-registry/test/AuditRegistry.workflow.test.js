import { expect } from "chai";
import { network } from "hardhat";

// Integration cases that complement the existing per-method and fuzz tests.
describe("AuditRegistry workflow boundaries", function () {
  let connection, ethers, registry, researcher, other;
  let opportunityId, proposalId, expiry;

  beforeEach(async function () {
    connection = await network.create();
    ({ ethers } = connection);
    [, researcher, other] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("AuditRegistry")).deploy();
    await registry.waitForDeployment();
    opportunityId = ethers.id("workflow-opportunity");
    proposalId = ethers.id("workflow-proposal");
    expiry = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await registry.commitOpportunity(opportunityId, 0, ethers.id("opportunity-v1"), expiry);
  });

  afterEach(async function () {
    await connection?.close();
  });

  const hashes = (version) => [ethers.id(`proposal-${version}`), ethers.id(`solution-${version}`)];
  const submit = () => registry.connect(researcher).commitProposal(
    proposalId, opportunityId, ...hashes("v1"), 0,
  );

  async function snapshot(id, kind) {
    const opportunity = kind === "opportunity";
    const record = await registry[opportunity ? "getOpportunity" : "getProposal"](id);
    const count = await registry[opportunity ? "opportunityRevisionCount" : "revisionCount"](id);
    const revisions = [];
    for (let i = 0n; i < count; i += 1n) {
      revisions.push(Array.from(await registry[opportunity ? "opportunityRevisionAt" : "revisionAt"](id, i)));
    }
    const anchors = [];
    const anchorCount = await registry.anchorCount(id);
    for (let i = 0n; i < anchorCount; i += 1n) {
      anchors.push(Array.from(await registry.anchorAt(id, i)));
    }
    const logs = await registry.queryFilter(registry.filters.EventAnchored(id));
    return { record: Array.from(record), revisions, anchors, logCount: logs.length };
  }

  for (const action of ["submit", "update"]) {
    it(`allows proposal ${action} one second before the deadline`, async function () {
      if (action === "update") await submit();
      await ethers.provider.send("evm_setNextBlockTimestamp", [expiry - 1]);
      const tx = action === "submit"
        ? await submit()
        : await registry.connect(researcher).updateHashes(proposalId, ...hashes("v2"), 0);
      const receipt = await tx.wait();
      expect((await ethers.provider.getBlock(receipt.blockNumber)).timestamp).to.equal(expiry - 1);
      expect((await registry.getProposal(proposalId)).updatedAt).to.equal(BigInt(expiry - 1));
      expect(await registry.revisionCount(proposalId)).to.equal(action === "submit" ? 1n : 2n);
    });

    it(`rejects proposal ${action} at the exact deadline without changing history`, async function () {
      if (action === "update") await submit();
      const before = action === "update" ? await snapshot(proposalId, "proposal") : null;
      await ethers.provider.send("evm_setNextBlockTimestamp", [expiry]);
      // Explicit gas mines the rejected call instead of stopping at gas estimation.
      const tx = action === "submit"
        ? registry.connect(researcher).commitProposal(proposalId, opportunityId, ...hashes("v1"), 0, { gasLimit: 1_000_000 })
        : registry.connect(researcher).updateHashes(proposalId, ...hashes("v2"), 0, { gasLimit: 1_000_000 });
      await expect(tx).to.be.revertedWithCustomError(registry, "InvalidState");
      expect((await ethers.provider.getBlock("latest")).timestamp).to.equal(expiry);
      if (before) {
        expect(await snapshot(proposalId, "proposal")).to.deep.equal(before);
      } else {
        await expect(registry.getProposal(proposalId)).to.be.revertedWithCustomError(registry, "InvalidInput");
        expect(await registry.queryFilter(registry.filters.EventAnchored(proposalId))).to.have.length(0);
      }
    });
  }

  it("rolls back an opportunity update that reuses a historical hash", async function () {
    const originalHash = ethers.id("opportunity-v1");
    await registry.updateOpportunity(opportunityId, ethers.id("opportunity-v2"), expiry + 100);
    const before = await snapshot(opportunityId, "opportunity");
    await expect(registry.updateOpportunity(opportunityId, originalHash, expiry + 200, { gasLimit: 1_000_000 }))
      .to.be.revertedWithCustomError(registry, "InvalidInput");
    expect(await snapshot(opportunityId, "opportunity")).to.deep.equal(before);
    await registry.updateOpportunity(opportunityId, ethers.id("opportunity-v3"), expiry + 200);
    expect(await registry.opportunityRevisionCount(opportunityId)).to.equal(3n);
    expect((await registry.getOpportunity(opportunityId)).expiresAt).to.equal(BigInt(expiry + 200));
  });

  it("rolls back a reused solution hash without consuming the new proposal hash", async function () {
    await submit();
    await registry.updateOpportunity(opportunityId, ethers.id("opportunity-v2"), expiry);
    const before = await snapshot(proposalId, "proposal");
    const [newProposalHash, newSolutionHash] = hashes("v2");
    await expect(registry.connect(researcher).updateHashes(proposalId, newProposalHash, hashes("v1")[1], 1, { gasLimit: 1_000_000 }))
      .to.be.revertedWithCustomError(registry, "InvalidInput");
    expect(await snapshot(proposalId, "proposal")).to.deep.equal(before);
    await registry.connect(researcher).updateHashes(proposalId, newProposalHash, newSolutionHash, 1);
    const saved = await registry.getProposal(proposalId);
    expect(saved.proposalHash).to.equal(newProposalHash);
    expect(saved.opportunityRevisionIndex).to.equal(1n);
    expect(saved.opportunityRevisionDigest).to.equal(ethers.id("opportunity-v2"));
    expect(await registry.revisionCount(proposalId)).to.equal(2n);
    expect(Array.from(await registry.revisionAt(proposalId, 0))).to.deep.equal(before.revisions[0]);
  });

  it("keeps two researchers' proposals separate when mined in the same block", async function () {
    const secondId = ethers.id("second-proposal");
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      const first = await registry.connect(researcher).commitProposal(
        proposalId, opportunityId, ...hashes("first"), 0, { gasLimit: 1_000_000 },
      );
      const second = await registry.connect(other).commitProposal(
        secondId, opportunityId, ...hashes("second"), 0, { gasLimit: 1_000_000 },
      );
      await ethers.provider.send("evm_mine", []);
      const a = await ethers.provider.getTransactionReceipt(first.hash);
      const b = await ethers.provider.getTransactionReceipt(second.hash);
      expect(a.status).to.equal(1);
      expect(b.status).to.equal(1);
      expect(a.blockNumber).to.equal(b.blockNumber);
      for (const [id, wallet, version] of [[proposalId, researcher, "first"], [secondId, other, "second"]]) {
        const saved = await registry.getProposal(id);
        expect(saved.researcher).to.equal(wallet.address);
        expect(saved.proposalHash).to.equal(hashes(version)[0]);
        expect(await registry.revisionCount(id)).to.equal(1n);
        expect(await registry.anchorCount(id)).to.equal(1n);
        expect((await registry.anchorAt(id, 0)).actor).to.equal(wallet.address);
      }
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
  });

  it("accepts only one of two competing submissions for the same proposal ID", async function () {
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      const first = await registry.connect(researcher).commitProposal(
        proposalId, opportunityId, ...hashes("first"), 0, { gasLimit: 1_000_000 },
      );
      const second = await registry.connect(other).commitProposal(
        proposalId, opportunityId, ...hashes("second"), 0, { gasLimit: 1_000_000 },
      );
      await ethers.provider.send("evm_mine", []);
      const receipts = await Promise.all([first, second].map((tx) => ethers.provider.getTransactionReceipt(tx.hash)));
      expect(receipts.map((receipt) => receipt.status).sort()).to.deep.equal([0, 1]);
      expect(receipts[0].blockNumber).to.equal(receipts[1].blockNumber);
      const winner = receipts[0].status === 1 ? researcher : other;
      const version = receipts[0].status === 1 ? "first" : "second";
      const saved = await registry.getProposal(proposalId);
      expect(saved.researcher).to.equal(winner.address);
      expect(saved.proposalHash).to.equal(hashes(version)[0]);
      expect(receipts.find((receipt) => receipt.status === 0).logs).to.have.length(0);
      expect(await registry.revisionCount(proposalId)).to.equal(1n);
      expect(await registry.anchorCount(proposalId)).to.equal(1n);
      expect((await registry.anchorAt(proposalId, 0)).actor).to.equal(winner.address);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
  });
});
