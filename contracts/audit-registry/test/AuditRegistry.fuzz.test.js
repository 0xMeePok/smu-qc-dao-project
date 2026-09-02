import { expect } from "chai";
import { network } from "hardhat";

const ZERO =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

const OpportunityKind = { BusinessProblem: 0 };

// Picks a random bytes32 that is not the zero hash (the contract rejects 0x00..00).
function randHash(ethers) {
  let value;
  do {
    value = ethers.hexlify(ethers.randomBytes(32));
  } while (value === ZERO);
  return value;
}

describe("AuditRegistry fuzz", function () {
  this.timeout(20_000);

  async function setup() {
    const { ethers } = await network.create();
    const wallets = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("AuditRegistry")).deploy();
    await registry.waitForDeployment();
    return { ethers, wallets, registry };
  }

  async function openPosting(ethers, registry, owner) {
    const opportunityId = randHash(ethers);
    await registry
      .connect(owner)
      .commitOpportunity(opportunityId, OpportunityKind.BusinessProblem, randHash(ethers), 0);
    return opportunityId;
  }

  it("random proposals store the submitter and both hashes", async function () {
    const { ethers, wallets, registry } = await setup();
    const [owner, researcher] = wallets;
    const opportunityId = await openPosting(ethers, registry, owner);

    for (let i = 0; i < 16; i += 1) {
      const proposalId = randHash(ethers);
      const proposalHash = randHash(ethers);
      const solutionHash = randHash(ethers);

      await registry
        .connect(researcher)
        .commitProposal(proposalId, opportunityId, proposalHash, solutionHash);

      const proposal = await registry.getProposal(proposalId);
      expect(proposal.researcher).to.equal(researcher.address);
      expect(proposal.opportunityId).to.equal(opportunityId);
      expect(proposal.opportunityRevisionIndex).to.equal(0n);
      expect(proposal.opportunityRevisionDigest).to.not.equal(ZERO);
      expect(proposal.proposalHash).to.equal(proposalHash);
      expect(proposal.solutionHash).to.equal(solutionHash);
      expect(proposal.withdrawn).to.equal(false);
      expect(proposal.exists).to.equal(true);
      expect(await registry.revisionCount(proposalId)).to.equal(1n);

      const first = await registry.revisionAt(proposalId, 0);
      expect(first.proposalHash).to.equal(proposalHash);
      expect(first.solutionHash).to.equal(solutionHash);
      expect(first.opportunityRevisionIndex).to.equal(proposal.opportunityRevisionIndex);
      expect(first.opportunityRevisionDigest).to.equal(proposal.opportunityRevisionDigest);
    }
  });

  it("a run of random edits keeps every old pair and only the latest on the struct", async function () {
    const { ethers, wallets, registry } = await setup();
    const [owner, researcher] = wallets;
    const opportunityId = await openPosting(ethers, registry, owner);
    const proposalId = randHash(ethers);

    const pairs = [{ proposalHash: randHash(ethers), solutionHash: randHash(ethers) }];
    await registry
      .connect(researcher)
      .commitProposal(proposalId, opportunityId, pairs[0].proposalHash, pairs[0].solutionHash);

    const createdAt = (await registry.getProposal(proposalId)).createdAt;

    for (let i = 0; i < 8; i += 1) {
      const next = { proposalHash: randHash(ethers), solutionHash: randHash(ethers) };
      pairs.push(next);
      await registry
        .connect(researcher)
        .updateHashes(proposalId, next.proposalHash, next.solutionHash);
    }

    const proposal = await registry.getProposal(proposalId);
    const last = pairs[pairs.length - 1];
    expect(proposal.proposalHash).to.equal(last.proposalHash);
    expect(proposal.solutionHash).to.equal(last.solutionHash);
    expect(proposal.createdAt).to.equal(createdAt);
    expect(proposal.updatedAt).to.be.gte(createdAt);
    expect(await registry.revisionCount(proposalId)).to.equal(BigInt(pairs.length));

    for (let i = 0; i < pairs.length; i += 1) {
      const revision = await registry.revisionAt(proposalId, i);
      expect(revision.proposalHash).to.equal(pairs[i].proposalHash);
      expect(revision.solutionHash).to.equal(pairs[i].solutionHash);
      expect(revision.opportunityRevisionIndex).to.equal(0n);
    }
  });

  it("a random other wallet cannot edit or withdraw someone else's proposal", async function () {
    const { ethers, wallets, registry } = await setup();
    const [owner, researcher] = wallets;
    const opportunityId = await openPosting(ethers, registry, owner);
    const proposalId = randHash(ethers);
    const original = { proposalHash: randHash(ethers), solutionHash: randHash(ethers) };

    await registry
      .connect(researcher)
      .commitProposal(proposalId, opportunityId, original.proposalHash, original.solutionHash);

    for (let i = 2; i < wallets.length; i += 1) {
      const stranger = wallets[i];
      await expect(
        registry
          .connect(stranger)
          .updateHashes(proposalId, randHash(ethers), randHash(ethers))
      ).to.be.revertedWithCustomError(registry, "AccessDenied");
      await expect(
        registry.connect(stranger).withdrawProposal(proposalId, randHash(ethers))
      ).to.be.revertedWithCustomError(registry, "AccessDenied");
    }

    const proposal = await registry.getProposal(proposalId);
    expect(proposal.proposalHash).to.equal(original.proposalHash);
    expect(proposal.solutionHash).to.equal(original.solutionHash);
    expect(proposal.withdrawn).to.equal(false);
  });

  it("random bad inputs bounce: zeros, reused hashes, unknown ids", async function () {
    const { ethers, wallets, registry } = await setup();
    const [owner, researcher] = wallets;
    const opportunityId = await openPosting(ethers, registry, owner);
    const proposalId = randHash(ethers);
    const proposalHash = randHash(ethers);
    const solutionHash = randHash(ethers);

    await registry
      .connect(researcher)
      .commitProposal(proposalId, opportunityId, proposalHash, solutionHash);

    await expect(
      registry.connect(researcher).updateHashes(proposalId, ZERO, randHash(ethers))
    ).to.be.revertedWithCustomError(registry, "InvalidInput");
    await expect(
      registry.connect(researcher).updateHashes(proposalId, randHash(ethers), ZERO)
    ).to.be.revertedWithCustomError(registry, "InvalidInput");
    await expect(
      registry.connect(researcher).updateHashes(proposalId, proposalHash, randHash(ethers))
    ).to.be.revertedWithCustomError(registry, "InvalidInput");
    await expect(
      registry.connect(researcher).updateHashes(proposalId, randHash(ethers), solutionHash)
    ).to.be.revertedWithCustomError(registry, "InvalidInput");
    await expect(
      registry.connect(researcher).withdrawProposal(proposalId, ZERO)
    ).to.be.revertedWithCustomError(registry, "InvalidInput");

    for (let i = 0; i < 12; i += 1) {
      const missing = randHash(ethers);
      await expect(registry.getProposal(missing)).to.be.revertedWithCustomError(
        registry,
        "InvalidInput"
      );
      await expect(
        registry.updateHashes(missing, randHash(ethers), randHash(ethers))
      ).to.be.revertedWithCustomError(registry, "InvalidInput");
    }
  });

  it("several people can file against the same posting without mixing their data", async function () {
    const { ethers, wallets, registry } = await setup();
    const [owner] = wallets;
    const opportunityId = await openPosting(ethers, registry, owner);
    const filed = [];

    for (let i = 1; i < Math.min(wallets.length, 6); i += 1) {
      const researcher = wallets[i];
      const proposalId = randHash(ethers);
      const proposalHash = randHash(ethers);
      const solutionHash = randHash(ethers);
      await registry
        .connect(researcher)
        .commitProposal(proposalId, opportunityId, proposalHash, solutionHash);
      filed.push({ researcher, proposalId, proposalHash, solutionHash });
    }

    for (const row of filed) {
      const proposal = await registry.getProposal(row.proposalId);
      expect(proposal.researcher).to.equal(row.researcher.address);
      expect(proposal.opportunityId).to.equal(opportunityId);
      expect(proposal.proposalHash).to.equal(row.proposalHash);
      expect(proposal.solutionHash).to.equal(row.solutionHash);
    }
  });

  it("any random wallet can record an evaluation authorized by the platform", async function () {
    const { ethers, wallets, registry } = await setup();
    const [owner, researcher] = wallets;
    const opportunityId = await openPosting(ethers, registry, owner);
    const proposalId = randHash(ethers);
    const proposalHash = randHash(ethers);
    const solutionHash = randHash(ethers);
    await registry
      .connect(researcher)
      .commitProposal(proposalId, opportunityId, proposalHash, solutionHash);

    const revisionDigest = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32"],
        [proposalHash, solutionHash]
      )
    );

    for (let i = 3; i < wallets.length; i += 1) {
      await registry.connect(wallets[i]).recordEvaluation(
        proposalId,
        randHash(ethers),
        0,
        revisionDigest
      );
    }
    expect(await registry.evaluationCount(proposalId)).to.equal(BigInt(wallets.length - 3));
  });

  it("after the researcher withdraws, later edits and evaluations fail but the last hashes stay", async function () {
    const { ethers, wallets, registry } = await setup();
    const [owner, researcher, evaluator] = wallets;
    const opportunityId = await openPosting(ethers, registry, owner);
    const proposalId = randHash(ethers);
    const proposalHash = randHash(ethers);
    const solutionHash = randHash(ethers);

    await registry
      .connect(researcher)
      .commitProposal(proposalId, opportunityId, proposalHash, solutionHash);
    await registry.connect(researcher).updateHashes(proposalId, randHash(ethers), randHash(ethers));
    const before = await registry.getProposal(proposalId);

    await registry.connect(researcher).withdrawProposal(proposalId, randHash(ethers));

    for (let i = 0; i < 6; i += 1) {
      await expect(
        registry.connect(researcher).updateHashes(proposalId, randHash(ethers), randHash(ethers))
      ).to.be.revertedWithCustomError(registry, "InvalidState");
      await expect(
        registry.connect(evaluator).recordEvaluation(proposalId, randHash(ethers), 0, randHash(ethers))
      ).to.be.revertedWithCustomError(registry, "InvalidState");
    }

    const after = await registry.getProposal(proposalId);
    expect(after.withdrawn).to.equal(true);
    expect(after.proposalHash).to.equal(before.proposalHash);
    expect(after.solutionHash).to.equal(before.solutionHash);
    expect(after.createdAt).to.equal(before.createdAt);
    expect(await registry.revisionCount(proposalId)).to.equal(2n);
  });
});
