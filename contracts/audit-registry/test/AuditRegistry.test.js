import { expect } from "chai";
import { network } from "hardhat";

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const PANIC_ARRAY_OUT_OF_BOUNDS = 0x32;

const EntityType = { Opportunity: 0, Proposal: 1 };
const EventType = {
  OpportunityPosted: 0,
  OpportunityUpdated: 1,
  OpportunityWithdrawn: 2,
  ProposalSubmitted: 3,
  ProposalUpdated: 4,
  ProposalWithdrawn: 5,
};
const ActorRole = { ProblemOwner: 0, Funder: 1, Researcher: 2 };
const OpportunityKind = { BusinessProblem: 0, OpenFunding: 1, FundingRequest: 2 };

function combinedHash(ethers, proposalHash, solutionHash) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [proposalHash, solutionHash]
    )
  );
}

describe("AuditRegistry", function () {
  async function deployFixture() {
    const { ethers } = await network.create();
    const [owner, researcher, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("AuditRegistry");
    const registry = await Factory.deploy();
    await registry.waitForDeployment();

    const latest = await ethers.provider.getBlock("latest");
    const opportunityId = ethers.id("opportunity-1");
    const opportunityHash = ethers.id("opportunity-hash-v1");
    const expiresAt = BigInt(latest.timestamp) + 90n * 24n * 60n * 60n;
    const proposalId = ethers.id("proposal-1");
    const proposalHash = ethers.id("proposal-hash-v1");
    const solutionHash = ethers.id("solution-hash-v1");

    return {
      ethers,
      registry,
      owner,
      researcher,
      other,
      opportunityId,
      opportunityHash,
      expiresAt,
      proposalId,
      proposalHash,
      solutionHash,
    };
  }

  async function commitFirstOpportunity(ctx, kind = OpportunityKind.BusinessProblem) {
    return ctx.registry
      .connect(ctx.owner)
      .commitOpportunity(ctx.opportunityId, kind, ctx.opportunityHash, ctx.expiresAt);
  }

  async function commitFirstProposal(ctx) {
    await commitFirstOpportunity(ctx, OpportunityKind.BusinessProblem);
    return commitProposalAtCurrentRevision(
      ctx.registry,
      ctx.researcher,
      ctx.proposalId,
      ctx.opportunityId,
      ctx.proposalHash,
      ctx.solutionHash
    );
  }

  async function currentOpportunityRevisionIndex(registry, opportunityId) {
    const count = await registry.opportunityRevisionCount(opportunityId);
    return count - 1n;
  }

  async function commitProposalAtCurrentRevision(
    registry,
    researcher,
    proposalId,
    opportunityId,
    proposalHash,
    solutionHash
  ) {
    const revisionIndex = await currentOpportunityRevisionIndex(registry, opportunityId);
    return registry.connect(researcher).commitProposal(
      proposalId,
      opportunityId,
      proposalHash,
      solutionHash,
      revisionIndex
    );
  }

  async function updateProposalAtCurrentRevision(
    registry,
    researcher,
    proposalId,
    proposalHash,
    solutionHash
  ) {
    const proposal = await registry.getProposal(proposalId);
    const revisionIndex = await currentOpportunityRevisionIndex(registry, proposal.opportunityId);
    return registry.connect(researcher).updateHashes(
      proposalId,
      proposalHash,
      solutionHash,
      revisionIndex
    );
  }

  async function timestampOf(ethers, tx) {
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    return block.timestamp;
  }

  describe("commitOpportunity", function () {
    describe("positive", function () {
      it("posts a business problem and records the first hash revision and anchor", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, opportunityId, opportunityHash, expiresAt } = ctx;

        const tx = await commitFirstOpportunity(ctx);
        const timestamp = await timestampOf(ethers, tx);

        await expect(tx)
          .to.emit(registry, "OpportunityCommitted")
          .withArgs(
            opportunityId,
            OpportunityKind.BusinessProblem,
            owner.address,
            opportunityHash,
            expiresAt
          );
        await expect(tx)
          .to.emit(registry, "EventAnchored")
          .withArgs(
            opportunityId,
            EntityType.Opportunity,
            EventType.OpportunityPosted,
            opportunityHash,
            ActorRole.ProblemOwner,
            owner.address,
            timestamp
          );

        const opportunity = await registry.getOpportunity(opportunityId);
        expect(opportunity.owner).to.equal(owner.address);
        expect(opportunity.kind).to.equal(BigInt(OpportunityKind.BusinessProblem));
        expect(opportunity.contentHash).to.equal(opportunityHash);
        expect(opportunity.createdAt).to.equal(timestamp);
        expect(opportunity.updatedAt).to.equal(timestamp);
        expect(opportunity.expiresAt).to.equal(expiresAt);
        expect(opportunity.withdrawn).to.equal(false);
        expect(opportunity.exists).to.equal(true);

        expect(await registry.opportunityRevisionCount(opportunityId)).to.equal(1n);
        const revision = await registry.opportunityRevisionAt(opportunityId, 0);
        expect(revision.contentHash).to.equal(opportunityHash);
        expect(revision.createdAt).to.equal(timestamp);
        expect(await registry.anchorCount(opportunityId)).to.equal(1n);
      });

      it("posts open funding as a funder and a funding request as a researcher", async function () {
        const { ethers, registry, owner, researcher } = await deployFixture();
        const openFundingId = ethers.id("open-funding-1");
        const fundingRequestId = ethers.id("funding-request-1");

        const fundingTx = await registry
          .connect(owner)
          .commitOpportunity(
            openFundingId,
            OpportunityKind.OpenFunding,
            ethers.id("open-funding-hash"),
            0
          );
        const fundingTimestamp = await timestampOf(ethers, fundingTx);
        await expect(fundingTx)
          .to.emit(registry, "EventAnchored")
          .withArgs(
            openFundingId,
            EntityType.Opportunity,
            EventType.OpportunityPosted,
            ethers.id("open-funding-hash"),
            ActorRole.Funder,
            owner.address,
            fundingTimestamp
          );

        const openFunding = await registry.getOpportunity(openFundingId);
        expect(openFunding.kind).to.equal(BigInt(OpportunityKind.OpenFunding));
        expect(openFunding.expiresAt).to.equal(0n);

        const requestTx = await registry
          .connect(researcher)
      .commitOpportunity(
        fundingRequestId,
        OpportunityKind.FundingRequest,
        ethers.id("funding-request-hash"),
        0
      );
        const requestTimestamp = await timestampOf(ethers, requestTx);
        await expect(requestTx)
          .to.emit(registry, "EventAnchored")
          .withArgs(
            fundingRequestId,
            EntityType.Opportunity,
            EventType.OpportunityPosted,
            ethers.id("funding-request-hash"),
            ActorRole.Researcher,
            researcher.address,
            requestTimestamp
          );
        expect((await registry.getOpportunity(fundingRequestId)).kind).to.equal(
          BigInt(OpportunityKind.FundingRequest)
        );
      });

      it("allows the same content hash on two different opportunities", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, opportunityHash, expiresAt } = ctx;

        await commitFirstOpportunity(ctx);
        const secondId = ethers.id("opportunity-2");
        await registry
          .connect(owner)
          .commitOpportunity(secondId, OpportunityKind.OpenFunding, opportunityHash, expiresAt);

        expect((await registry.getOpportunity(secondId)).contentHash).to.equal(opportunityHash);
      });
    });

    describe("negative", function () {
      it("rejects a zero opportunity id", async function () {
        const { registry, opportunityHash, expiresAt } = await deployFixture();
        await expect(
          registry.commitOpportunity(
            ZERO_BYTES32,
            OpportunityKind.BusinessProblem,
            opportunityHash,
            expiresAt
          )
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a zero content hash", async function () {
        const { registry, opportunityId, expiresAt } = await deployFixture();
        await expect(
          registry.commitOpportunity(
            opportunityId,
            OpportunityKind.BusinessProblem,
            ZERO_BYTES32,
            expiresAt
          )
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a past expiry and an expiry equal to the current timestamp", async function () {
        const { ethers, registry, opportunityId, opportunityHash } = await deployFixture();
        const latest = await ethers.provider.getBlock("latest");

        await expect(
          registry.commitOpportunity(
            opportunityId,
            OpportunityKind.BusinessProblem,
            opportunityHash,
            1
          )
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
        await expect(
          registry.commitOpportunity(
            opportunityId,
            OpportunityKind.BusinessProblem,
            opportunityHash,
            latest.timestamp
          )
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a duplicate opportunity id", async function () {
        const ctx = await deployFixture();
        await commitFirstOpportunity(ctx);
        await expect(commitFirstOpportunity(ctx)).to.be.revertedWithCustomError(
          ctx.registry,
          "InvalidInput"
        );
      });

      it("rejects an opportunity id that is already used by a proposal", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, proposalId } = ctx;

        await commitFirstProposal(ctx);
        await expect(
          registry
            .connect(owner)
            .commitOpportunity(proposalId, OpportunityKind.OpenFunding, ethers.id("other"), 0)
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });
    });
  });

  describe("updateOpportunity", function () {
    describe("positive", function () {
      it("lets the owner replace the hash, keep history, and extend expiry", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, opportunityId, opportunityHash, expiresAt } = ctx;

        await commitFirstOpportunity(ctx);
        const nextHash = ethers.id("opportunity-hash-v2");
        const nextExpiry = expiresAt + 30n * 24n * 60n * 60n;
        const tx = await registry
          .connect(owner)
          .updateOpportunity(opportunityId, nextHash, nextExpiry);
        const timestamp = await timestampOf(ethers, tx);

        await expect(tx)
          .to.emit(registry, "OpportunityUpdated")
          .withArgs(opportunityId, owner.address, nextHash, nextExpiry);
        await expect(tx)
          .to.emit(registry, "EventAnchored")
          .withArgs(
            opportunityId,
            EntityType.Opportunity,
            EventType.OpportunityUpdated,
            nextHash,
            ActorRole.ProblemOwner,
            owner.address,
            timestamp
          );

        const opportunity = await registry.getOpportunity(opportunityId);
        expect(opportunity.contentHash).to.equal(nextHash);
        expect(opportunity.expiresAt).to.equal(nextExpiry);
        expect(opportunity.updatedAt).to.equal(timestamp);
        expect(await registry.opportunityRevisionCount(opportunityId)).to.equal(2n);
        expect((await registry.opportunityRevisionAt(opportunityId, 0)).contentHash).to.equal(
          opportunityHash
        );
        expect((await registry.opportunityRevisionAt(opportunityId, 1)).contentHash).to.equal(
          nextHash
        );
        expect(await registry.anchorCount(opportunityId)).to.equal(2n);
      });
    });

    describe("negative", function () {
      it("rejects an unknown opportunity", async function () {
        const { registry, opportunityId, opportunityHash, expiresAt } = await deployFixture();
        await expect(
          registry.updateOpportunity(opportunityId, opportunityHash, expiresAt)
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a caller who is not the owner", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, other, opportunityId, expiresAt } = ctx;
        await commitFirstOpportunity(ctx);
        await expect(
          registry
            .connect(other)
            .updateOpportunity(opportunityId, ethers.id("opportunity-hash-v2"), expiresAt)
        ).to.be.revertedWithCustomError(registry, "AccessDenied");
      });

      it("rejects a zero hash or a past expiry", async function () {
        const ctx = await deployFixture();
        const { registry, owner, opportunityId, expiresAt } = ctx;
        await commitFirstOpportunity(ctx);

        await expect(
          registry.connect(owner).updateOpportunity(opportunityId, ZERO_BYTES32, expiresAt)
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
        await expect(
          registry.connect(owner).updateOpportunity(opportunityId, ctx.ethers.id("next"), 1)
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a reused content hash on the same opportunity", async function () {
        const ctx = await deployFixture();
        const { registry, owner, opportunityId, opportunityHash, expiresAt } = ctx;
        await commitFirstOpportunity(ctx);
        await expect(
          registry.connect(owner).updateOpportunity(opportunityId, opportunityHash, expiresAt)
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects an update after the posting has already expired", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, opportunityId } = ctx;
        const latest = await ethers.provider.getBlock("latest");
        await registry
          .connect(owner)
          .commitOpportunity(
            opportunityId,
            OpportunityKind.BusinessProblem,
            ctx.opportunityHash,
            BigInt(latest.timestamp) + 2n
          );
        await ethers.provider.send("evm_increaseTime", [5]);
        await ethers.provider.send("evm_mine", []);

        await expect(
          registry.connect(owner).updateOpportunity(opportunityId, ethers.id("reopen"), 0)
        ).to.be.revertedWithCustomError(registry, "InvalidState");
      });

      it("rejects an update after withdrawal", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, opportunityId } = ctx;
        await commitFirstOpportunity(ctx);
        await registry.connect(owner).withdrawOpportunity(opportunityId, ethers.id("reason"));
        await expect(
          registry.connect(owner).updateOpportunity(opportunityId, ethers.id("after-withdraw"), 0)
        ).to.be.revertedWithCustomError(registry, "InvalidState");
      });
    });
  });

  describe("withdrawOpportunity", function () {
    describe("positive", function () {
      it("lets the owner withdraw and keeps the posting readable", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, other, opportunityId } = ctx;
        await commitFirstOpportunity(ctx);
        const evidenceHash = ethers.id("withdraw-reason");

        const tx = await registry.connect(owner).withdrawOpportunity(opportunityId, evidenceHash);
        const timestamp = await timestampOf(ethers, tx);

        await expect(tx)
          .to.emit(registry, "OpportunityWithdrawn")
          .withArgs(opportunityId, owner.address, evidenceHash);
        await expect(tx)
          .to.emit(registry, "EventAnchored")
          .withArgs(
            opportunityId,
            EntityType.Opportunity,
            EventType.OpportunityWithdrawn,
            evidenceHash,
            ActorRole.ProblemOwner,
            owner.address,
            timestamp
          );

        const opportunity = await registry.connect(other).getOpportunity(opportunityId);
        expect(opportunity.withdrawn).to.equal(true);
        expect(opportunity.exists).to.equal(true);
        expect(opportunity.updatedAt).to.equal(timestamp);
        expect(await registry.connect(other).anchorCount(opportunityId)).to.equal(2n);
      });
    });

    describe("negative", function () {
      it("rejects an unknown opportunity", async function () {
        const { ethers, registry, opportunityId } = await deployFixture();
        await expect(
          registry.withdrawOpportunity(opportunityId, ethers.id("reason"))
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a caller who is not the owner", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, other, opportunityId } = ctx;
        await commitFirstOpportunity(ctx);
        await expect(
          registry.connect(other).withdrawOpportunity(opportunityId, ethers.id("reason"))
        ).to.be.revertedWithCustomError(registry, "AccessDenied");
      });

      it("rejects a zero evidence hash", async function () {
        const ctx = await deployFixture();
        const { registry, owner, opportunityId } = ctx;
        await commitFirstOpportunity(ctx);
        await expect(
          registry.connect(owner).withdrawOpportunity(opportunityId, ZERO_BYTES32)
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a second withdrawal and blocks new proposals", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, researcher, opportunityId, proposalId, proposalHash, solutionHash } =
          ctx;
        await commitFirstOpportunity(ctx);
        await registry.connect(owner).withdrawOpportunity(opportunityId, ethers.id("reason"));

        await expect(
          registry.connect(owner).withdrawOpportunity(opportunityId, ethers.id("again"))
        ).to.be.revertedWithCustomError(registry, "InvalidState");
        await expect(
          commitProposalAtCurrentRevision(
            registry, researcher, proposalId, opportunityId, proposalHash, solutionHash
          )
        ).to.be.revertedWithCustomError(registry, "InvalidState");
      });
    });
  });

  describe("commitProposal", function () {
    describe("positive", function () {
      it("stores both hashes against a live opportunity and records the first revision", async function () {
        const ctx = await deployFixture();
        const {
          ethers,
          registry,
          researcher,
          opportunityId,
          proposalId,
          proposalHash,
          solutionHash,
        } = ctx;

        const tx = await commitFirstProposal(ctx);
        const timestamp = await timestampOf(ethers, tx);
        const contentHash = combinedHash(ethers, proposalHash, solutionHash);

        await expect(tx)
          .to.emit(registry, "ProposalCommitted")
          .withArgs(
            proposalId,
            opportunityId,
            researcher.address,
            proposalHash,
            solutionHash,
            0,
            ctx.opportunityHash
          );
        await expect(tx)
          .to.emit(registry, "EventAnchored")
          .withArgs(
            proposalId,
            EntityType.Proposal,
            EventType.ProposalSubmitted,
            contentHash,
            ActorRole.Researcher,
            researcher.address,
            timestamp
          );

        const proposal = await registry.getProposal(proposalId);
        expect(proposal.researcher).to.equal(researcher.address);
        expect(proposal.opportunityId).to.equal(opportunityId);
        expect(proposal.opportunityRevisionIndex).to.equal(0n);
        expect(proposal.opportunityRevisionDigest).to.equal(ctx.opportunityHash);
        expect(proposal.proposalHash).to.equal(proposalHash);
        expect(proposal.solutionHash).to.equal(solutionHash);
        expect(proposal.createdAt).to.equal(timestamp);
        expect(proposal.updatedAt).to.equal(timestamp);
        expect(proposal.withdrawn).to.equal(false);
        expect(proposal.exists).to.equal(true);

        expect(await registry.revisionCount(proposalId)).to.equal(1n);
        const revision = await registry.revisionAt(proposalId, 0);
        expect(revision.proposalHash).to.equal(proposalHash);
        expect(revision.solutionHash).to.equal(solutionHash);
        expect(revision.opportunityRevisionIndex).to.equal(0n);
        expect(revision.opportunityRevisionDigest).to.equal(ctx.opportunityHash);
        expect(revision.createdAt).to.equal(timestamp);
        expect(await registry.anchorCount(proposalId)).to.equal(1n);
      });

      it("accepts a second researcher on the same open-funding opportunity", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, researcher, other } = ctx;
        const opportunityId = ethers.id("shared-opportunity");

        await registry
          .connect(owner)
          .commitOpportunity(
            opportunityId,
            OpportunityKind.OpenFunding,
            ethers.id("open-funding-hash"),
            0
          );
        await commitProposalAtCurrentRevision(
          registry,
          researcher,
          ethers.id("proposal-a"),
          opportunityId,
          ethers.id("proposal-a-hash"),
          ethers.id("solution-a-hash")
        );
        await commitProposalAtCurrentRevision(
          registry,
          other,
          ethers.id("proposal-b"),
          opportunityId,
          ethers.id("proposal-b-hash"),
          ethers.id("solution-b-hash")
        );

        expect((await registry.getProposal(ethers.id("proposal-a"))).researcher).to.equal(
          researcher.address
        );
        expect((await registry.getProposal(ethers.id("proposal-b"))).researcher).to.equal(
          other.address
        );
      });

      it("binds the proposal to the posting revision that was live at submit time", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, researcher, opportunityId, expiresAt } = ctx;
        await commitFirstOpportunity(ctx);
        const nextHash = ethers.id("opportunity-hash-v2");
        await registry.connect(owner).updateOpportunity(opportunityId, nextHash, expiresAt);

        const laterId = ethers.id("proposal-after-update");
        await commitProposalAtCurrentRevision(
          registry, researcher, laterId, opportunityId, ethers.id("p-after"), ethers.id("s-after")
        );

        const later = await registry.getProposal(laterId);
        expect(later.opportunityRevisionIndex).to.equal(1n);
        expect(later.opportunityRevisionDigest).to.equal(nextHash);
        const laterRevision = await registry.revisionAt(laterId, 0);
        expect(laterRevision.opportunityRevisionIndex).to.equal(1n);
        expect(laterRevision.opportunityRevisionDigest).to.equal(nextHash);
      });

      it("allows the same value for the proposal hash and the solution hash", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, researcher, opportunityId } = ctx;
        await commitFirstOpportunity(ctx);

        const proposalId = ethers.id("same-hash-proposal");
        const both = ethers.id("one-hash-for-both");
        await commitProposalAtCurrentRevision(
          registry, researcher, proposalId, opportunityId, both, both
        );

        const proposal = await registry.getProposal(proposalId);
        expect(proposal.proposalHash).to.equal(both);
        expect(proposal.solutionHash).to.equal(both);
        expect((await registry.revisionAt(proposalId, 0)).proposalHash).to.equal(both);
      });

      it("does not move createdAt when the researcher edits later", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, researcher, proposalId } = ctx;
        await commitFirstProposal(ctx);
        const createdAt = (await registry.getProposal(proposalId)).createdAt;

        await ethers.provider.send("evm_increaseTime", [60]);
        await ethers.provider.send("evm_mine", []);
        await updateProposalAtCurrentRevision(
          registry,
          researcher,
          proposalId,
          ethers.id("proposal-hash-later"),
          ethers.id("solution-hash-later")
        );

        const proposal = await registry.getProposal(proposalId);
        expect(proposal.createdAt).to.equal(createdAt);
        expect(proposal.updatedAt).to.be.greaterThan(createdAt);
      });

      it("allows the same proposal and solution hashes on two different proposals", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, researcher, other, proposalHash, solutionHash } = ctx;

        await commitFirstProposal(ctx);
        const secondOpportunity = ethers.id("opportunity-2");
        await registry
          .connect(ctx.owner)
          .commitOpportunity(secondOpportunity, OpportunityKind.FundingRequest, ethers.id("fr"), 0);
        await commitProposalAtCurrentRevision(
          registry, other, ethers.id("proposal-2"), secondOpportunity, proposalHash, solutionHash
        );

        const copy = await registry.getProposal(ethers.id("proposal-2"));
        expect(copy.proposalHash).to.equal(proposalHash);
        expect(copy.solutionHash).to.equal(solutionHash);
        expect(copy.researcher).to.equal(other.address);
        expect(researcher.address).to.not.equal(other.address);
      });
    });

    describe("negative", function () {
      it("rejects a zero proposal id, proposal hash, or solution hash", async function () {
        const ctx = await deployFixture();
        const { registry, opportunityId, proposalId, proposalHash, solutionHash } = ctx;
        await commitFirstOpportunity(ctx);

        await expect(
          registry.commitProposal(
            ZERO_BYTES32, opportunityId, proposalHash, solutionHash, 0
          )
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
        await expect(
          registry.commitProposal(
            proposalId, opportunityId, ZERO_BYTES32, solutionHash, 0
          )
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
        await expect(
          registry.commitProposal(
            proposalId, opportunityId, proposalHash, ZERO_BYTES32, 0
          )
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a duplicate proposal id", async function () {
        const ctx = await deployFixture();
        const { registry, researcher, opportunityId, proposalId, proposalHash, solutionHash } = ctx;
        await commitFirstProposal(ctx);
        await expect(
          registry
            .connect(researcher)
            .commitProposal(
              proposalId, opportunityId, proposalHash, solutionHash, 0
            )
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a proposal id that is already used by an opportunity", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, researcher, opportunityId } = ctx;
        await commitFirstOpportunity(ctx);
        await expect(
          registry
            .connect(researcher)
            .commitProposal(
              opportunityId,
              opportunityId,
              ethers.id("proposal-hash"),
              ethers.id("solution-hash"),
              0
            )
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a proposal against a missing opportunity", async function () {
        const ctx = await deployFixture();
        const { registry, researcher, opportunityId, proposalId, proposalHash, solutionHash } = ctx;
        await expect(
          registry
            .connect(researcher)
            .commitProposal(
              proposalId, opportunityId, proposalHash, solutionHash, 0
            )
        ).to.be.revertedWithCustomError(registry, "InvalidState");
      });

      it("rejects a proposal against an expired opportunity", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, researcher, opportunityId, proposalId, proposalHash, solutionHash } =
          ctx;
        const latest = await ethers.provider.getBlock("latest");
        await registry
          .connect(owner)
          .commitOpportunity(
            opportunityId,
            OpportunityKind.BusinessProblem,
            ctx.opportunityHash,
            BigInt(latest.timestamp) + 2n
          );
        await ethers.provider.send("evm_increaseTime", [5]);
        await ethers.provider.send("evm_mine", []);

        await expect(
          registry
            .connect(researcher)
            .commitProposal(
              proposalId, opportunityId, proposalHash, solutionHash, 0
            )
        ).to.be.revertedWithCustomError(registry, "InvalidState");
      });

      it("rejects a proposal when the opportunity changed after it was viewed", async function () {
        const ctx = await deployFixture();
        const {
          ethers,
          registry,
          owner,
          researcher,
          opportunityId,
          proposalId,
          proposalHash,
          solutionHash,
          expiresAt,
        } = ctx;
        await commitFirstOpportunity(ctx);
        const viewedRevisionIndex = await currentOpportunityRevisionIndex(registry, opportunityId);
        await registry.connect(owner).updateOpportunity(
          opportunityId,
          ethers.id("opportunity-hash-v2"),
          expiresAt
        );

        await expect(
          registry.connect(researcher).commitProposal(
            proposalId,
            opportunityId,
            proposalHash,
            solutionHash,
            viewedRevisionIndex
          )
        ).to.be.revertedWithCustomError(registry, "InvalidState");
      });
    });
  });

  describe("updateHashes", function () {
    describe("positive", function () {
      it("appends the previous hash pair and refreshes the current proposal", async function () {
        const ctx = await deployFixture();
        const {
          ethers,
          registry,
          researcher,
          opportunityId,
          proposalId,
          proposalHash,
          solutionHash,
        } = ctx;

        await commitFirstProposal(ctx);
        const nextProposalHash = ethers.id("proposal-hash-v2");
        const nextSolutionHash = ethers.id("solution-hash-v2");
        const tx = await updateProposalAtCurrentRevision(
          registry, researcher, proposalId, nextProposalHash, nextSolutionHash
        );
        const timestamp = await timestampOf(ethers, tx);
        const contentHash = combinedHash(ethers, nextProposalHash, nextSolutionHash);

        await expect(tx)
          .to.emit(registry, "HashesUpdated")
          .withArgs(
            proposalId,
            opportunityId,
            researcher.address,
            nextProposalHash,
            nextSolutionHash,
            0,
            ctx.opportunityHash
          );
        await expect(tx)
          .to.emit(registry, "EventAnchored")
          .withArgs(
            proposalId,
            EntityType.Proposal,
            EventType.ProposalUpdated,
            contentHash,
            ActorRole.Researcher,
            researcher.address,
            timestamp
          );

        const proposal = await registry.getProposal(proposalId);
        expect(proposal.proposalHash).to.equal(nextProposalHash);
        expect(proposal.solutionHash).to.equal(nextSolutionHash);
        expect(proposal.updatedAt).to.equal(timestamp);
        expect(await registry.revisionCount(proposalId)).to.equal(2n);
        const previous = await registry.revisionAt(proposalId, 0);
        expect(previous.proposalHash).to.equal(proposalHash);
        expect(previous.solutionHash).to.equal(solutionHash);
        expect(previous.opportunityRevisionIndex).to.equal(0n);
        expect(previous.opportunityRevisionDigest).to.equal(ctx.opportunityHash);
        const latest = await registry.revisionAt(proposalId, 1);
        expect(latest.proposalHash).to.equal(nextProposalHash);
        expect(latest.solutionHash).to.equal(nextSolutionHash);
        expect(latest.opportunityRevisionIndex).to.equal(0n);
        expect(latest.opportunityRevisionDigest).to.equal(ctx.opportunityHash);

        await updateProposalAtCurrentRevision(
          registry,
          researcher,
          proposalId,
          ethers.id("proposal-hash-v3"),
          ethers.id("solution-hash-v3")
        );
        expect(await registry.revisionCount(proposalId)).to.equal(3n);
      });

      it("keeps the original posting snapshot until the researcher edits again", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, researcher, opportunityId, proposalId, opportunityHash, expiresAt } =
          ctx;
        await commitFirstProposal(ctx);
        const nextHash = ethers.id("opportunity-hash-v2");
        await registry.connect(owner).updateOpportunity(opportunityId, nextHash, expiresAt);

        const beforeEdit = await registry.getProposal(proposalId);
        expect(beforeEdit.opportunityRevisionIndex).to.equal(0n);
        expect(beforeEdit.opportunityRevisionDigest).to.equal(opportunityHash);

        await updateProposalAtCurrentRevision(
          registry,
          researcher,
          proposalId,
          ethers.id("proposal-hash-v2"),
          ethers.id("solution-hash-v2")
        );
        const afterEdit = await registry.getProposal(proposalId);
        expect(afterEdit.opportunityRevisionIndex).to.equal(1n);
        expect(afterEdit.opportunityRevisionDigest).to.equal(nextHash);

        const firstRevision = await registry.revisionAt(proposalId, 0);
        expect(firstRevision.opportunityRevisionIndex).to.equal(0n);
        expect(firstRevision.opportunityRevisionDigest).to.equal(opportunityHash);
        const secondRevision = await registry.revisionAt(proposalId, 1);
        expect(secondRevision.opportunityRevisionIndex).to.equal(1n);
        expect(secondRevision.opportunityRevisionDigest).to.equal(nextHash);
      });
    });

    describe("negative", function () {
      it("rejects an unknown proposal", async function () {
        const { ethers, registry, proposalId } = await deployFixture();
        await expect(
          registry.updateHashes(proposalId, ethers.id("p2"), ethers.id("s2"), 0)
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a caller who is not the researcher", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, other, proposalId } = ctx;
        await commitFirstProposal(ctx);
        await expect(
          updateProposalAtCurrentRevision(
            registry,
            other,
            proposalId,
            ethers.id("proposal-hash-v2"),
            ethers.id("solution-hash-v2")
          )
        ).to.be.revertedWithCustomError(registry, "AccessDenied");
      });

      it("rejects a zero proposal or solution hash", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, researcher, proposalId } = ctx;
        await commitFirstProposal(ctx);
        await expect(
          updateProposalAtCurrentRevision(
            registry, researcher, proposalId, ZERO_BYTES32, ethers.id("s2")
          )
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
        await expect(
          updateProposalAtCurrentRevision(
            registry, researcher, proposalId, ethers.id("p2"), ZERO_BYTES32
          )
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a reused proposal or solution hash on the same proposal", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, researcher, proposalId, proposalHash, solutionHash } = ctx;
        await commitFirstProposal(ctx);
        await expect(
          updateProposalAtCurrentRevision(
            registry, researcher, proposalId, proposalHash, ethers.id("solution-hash-v2")
          )
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
        await expect(
          updateProposalAtCurrentRevision(
            registry, researcher, proposalId, ethers.id("proposal-hash-v2"), solutionHash
          )
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects an update when the opportunity changed after it was viewed", async function () {
        const ctx = await deployFixture();
        const {
          ethers,
          registry,
          owner,
          researcher,
          opportunityId,
          proposalId,
          expiresAt,
        } = ctx;
        await commitFirstProposal(ctx);
        const viewedRevisionIndex = await currentOpportunityRevisionIndex(registry, opportunityId);
        await registry.connect(owner).updateOpportunity(
          opportunityId,
          ethers.id("opportunity-hash-v2"),
          expiresAt
        );

        await expect(
          registry.connect(researcher).updateHashes(
            proposalId,
            ethers.id("proposal-hash-v2"),
            ethers.id("solution-hash-v2"),
            viewedRevisionIndex
          )
        ).to.be.revertedWithCustomError(registry, "InvalidState");
      });

      it("rejects an edit after the posting is withdrawn or past its deadline", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, researcher, opportunityId, proposalId } = ctx;
        await commitFirstProposal(ctx);

        await registry.connect(owner).withdrawOpportunity(opportunityId, ethers.id("closed"));
        await expect(
          updateProposalAtCurrentRevision(
            registry,
            researcher,
            proposalId,
            ethers.id("proposal-hash-late"),
            ethers.id("solution-hash-late")
          )
        ).to.be.revertedWithCustomError(registry, "InvalidState");

        const lateId = ethers.id("expiring-opportunity");
        const lateProposal = ethers.id("expiring-proposal");
        const latest = await ethers.provider.getBlock("latest");
        await registry
          .connect(owner)
          .commitOpportunity(
            lateId,
            OpportunityKind.BusinessProblem,
            ethers.id("expiring-hash"),
            BigInt(latest.timestamp) + 3n
          );
        await commitProposalAtCurrentRevision(
          registry,
          researcher,
          lateProposal,
          lateId,
          ethers.id("p-early"),
          ethers.id("s-early")
        );
        await ethers.provider.send("evm_increaseTime", [10]);
        await ethers.provider.send("evm_mine", []);
        await expect(
          updateProposalAtCurrentRevision(
            registry, researcher, lateProposal, ethers.id("p-late"), ethers.id("s-late")
          )
        ).to.be.revertedWithCustomError(registry, "InvalidState");
      });
    });
  });

  describe("withdrawProposal", function () {
    describe("positive", function () {
      it("lets the researcher withdraw and keeps the proposal readable", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, researcher, other, proposalId } = ctx;
        await commitFirstProposal(ctx);
        const evidenceHash = ethers.id("proposal-withdraw-reason");

        const tx = await registry.connect(researcher).withdrawProposal(proposalId, evidenceHash);
        const timestamp = await timestampOf(ethers, tx);

        await expect(tx)
          .to.emit(registry, "ProposalWithdrawn")
          .withArgs(proposalId, researcher.address, evidenceHash);
        await expect(tx)
          .to.emit(registry, "EventAnchored")
          .withArgs(
            proposalId,
            EntityType.Proposal,
            EventType.ProposalWithdrawn,
            evidenceHash,
            ActorRole.Researcher,
            researcher.address,
            timestamp
          );

        const proposal = await registry.connect(other).getProposal(proposalId);
        expect(proposal.withdrawn).to.equal(true);
        expect(proposal.exists).to.equal(true);
        expect(proposal.updatedAt).to.equal(timestamp);
      });
    });

    describe("negative", function () {
      it("rejects an unknown proposal", async function () {
        const { ethers, registry, proposalId } = await deployFixture();
        await expect(
          registry.withdrawProposal(proposalId, ethers.id("reason"))
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a caller who is not the researcher", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, other, proposalId } = ctx;
        await commitFirstProposal(ctx);
        await expect(
          registry.connect(other).withdrawProposal(proposalId, ethers.id("reason"))
        ).to.be.revertedWithCustomError(registry, "AccessDenied");
      });

      it("rejects a zero evidence hash", async function () {
        const ctx = await deployFixture();
        const { registry, researcher, proposalId } = ctx;
        await commitFirstProposal(ctx);
        await expect(
          registry.connect(researcher).withdrawProposal(proposalId, ZERO_BYTES32)
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a second withdrawal and blocks later edits", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, researcher, proposalId } = ctx;
        await commitFirstProposal(ctx);
        await registry
          .connect(researcher)
          .withdrawProposal(proposalId, ethers.id("proposal-withdraw-reason"));

        await expect(
          registry.connect(researcher).withdrawProposal(proposalId, ethers.id("again"))
        ).to.be.revertedWithCustomError(registry, "InvalidState");
        await expect(
          updateProposalAtCurrentRevision(
            registry,
            researcher,
            proposalId,
            ethers.id("proposal-hash-v2"),
            ethers.id("solution-hash-v2")
          )
        ).to.be.revertedWithCustomError(registry, "InvalidState");
      });
    });
  });

  describe("reads", function () {
    describe("positive", function () {
      it("lets any account read opportunity, proposal, revision, and anchor data", async function () {
        const ctx = await deployFixture();
        const { registry, other, opportunityId, proposalId } = ctx;
        await commitFirstProposal(ctx);

        const opportunity = await registry.connect(other).getOpportunity(opportunityId);
        const proposal = await registry.connect(other).getProposal(proposalId);
        expect(opportunity.exists).to.equal(true);
        expect(proposal.exists).to.equal(true);
        expect(await registry.connect(other).opportunityRevisionCount(opportunityId)).to.equal(1n);
        expect(await registry.connect(other).revisionCount(proposalId)).to.equal(1n);
        expect(await registry.connect(other).anchorCount(opportunityId)).to.equal(1n);
        expect(await registry.connect(other).anchorCount(proposalId)).to.equal(1n);
      });
    });

    describe("negative", function () {
      it("rejects reads against an unknown entity", async function () {
        const { registry, opportunityId, proposalId } = await deployFixture();

        await expect(registry.getOpportunity(opportunityId)).to.be.revertedWithCustomError(
          registry,
          "InvalidInput"
        );
        await expect(registry.getProposal(proposalId)).to.be.revertedWithCustomError(
          registry,
          "InvalidInput"
        );
        await expect(
          registry.opportunityRevisionCount(opportunityId)
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
        await expect(registry.opportunityRevisionAt(opportunityId, 0)).to.be.revertedWithCustomError(
          registry,
          "InvalidInput"
        );
        await expect(registry.revisionCount(proposalId)).to.be.revertedWithCustomError(
          registry,
          "InvalidInput"
        );
        await expect(registry.revisionAt(proposalId, 0)).to.be.revertedWithCustomError(
          registry,
          "InvalidInput"
        );
        await expect(registry.anchorCount(proposalId)).to.be.revertedWithCustomError(
          registry,
          "InvalidInput"
        );
        await expect(registry.anchorAt(proposalId, 0)).to.be.revertedWithCustomError(
          registry,
          "InvalidInput"
        );
      });

      it("rejects an out-of-range revision or anchor index", async function () {
        const ctx = await deployFixture();
        const { registry, opportunityId, proposalId } = ctx;
        await commitFirstProposal(ctx);

        await expect(registry.opportunityRevisionAt(opportunityId, 1)).to.be.revertedWithPanic(
          PANIC_ARRAY_OUT_OF_BOUNDS
        );
        await expect(registry.revisionAt(proposalId, 1)).to.be.revertedWithPanic(
          PANIC_ARRAY_OUT_OF_BOUNDS
        );
        await expect(registry.anchorAt(opportunityId, 1)).to.be.revertedWithPanic(
          PANIC_ARRAY_OUT_OF_BOUNDS
        );
        await expect(registry.anchorAt(proposalId, 1)).to.be.revertedWithPanic(
          PANIC_ARRAY_OUT_OF_BOUNDS
        );
      });
    });
  });
});
