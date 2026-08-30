import { expect } from "chai";
import { network } from "hardhat";

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const PANIC_ARRAY_OUT_OF_BOUNDS = 0x32;

const EntityType = { Opportunity: 0, Proposal: 1, Evaluation: 2 };
const EventType = {
  OpportunityPosted: 0,
  OpportunityUpdated: 1,
  OpportunityWithdrawn: 2,
  ProposalSubmitted: 3,
  ProposalUpdated: 4,
  ProposalWithdrawn: 5,
  EvaluationCompleted: 6,
};
const ActorRole = { ProblemOwner: 0, Funder: 1, Researcher: 2, Evaluator: 3 };
const OpportunityKind = { BusinessProblem: 0, OpenFunding: 1, FundingRequest: 2 };

function combinedHash(ethers, proposalHash, solutionHash) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [proposalHash, solutionHash]
    )
  );
}

async function currentProposalRevision(registry, ethers, proposalId) {
  const proposal = await registry.getProposal(proposalId);
  const index = (await registry.revisionCount(proposalId)) - 1n;
  return {
    index,
    digest: combinedHash(ethers, proposal.proposalHash, proposal.solutionHash),
  };
}

async function recordCurrentEvaluation(registry, evaluator, ethers, proposalId, evaluationHash) {
  const { index, digest } = await currentProposalRevision(registry, ethers, proposalId);
  return registry.connect(evaluator).recordEvaluation(proposalId, evaluationHash, index, digest);
}

describe("AuditRegistry", function () {
  async function deployFixture() {
    const { ethers } = await network.create();
    const [owner, researcher, evaluator, other] = await ethers.getSigners();
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
      evaluator,
      other,
      opportunityId,
      opportunityHash,
      expiresAt,
      proposalId,
      proposalHash,
      solutionHash,
    };
  }

  async function commitFirstOpportunity(
    ctx,
    kind = OpportunityKind.BusinessProblem,
    evaluators = []
  ) {
    return ctx.registry
      .connect(ctx.owner)
      .commitOpportunity(ctx.opportunityId, kind, ctx.opportunityHash, ctx.expiresAt, evaluators);
  }

  async function commitFirstProposal(ctx, evaluators = []) {
    await commitFirstOpportunity(ctx, OpportunityKind.BusinessProblem, evaluators);
    return ctx.registry
      .connect(ctx.researcher)
      .commitProposal(
        ctx.proposalId,
        ctx.opportunityId,
        ctx.proposalHash,
        ctx.solutionHash
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
            0,
            []
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
        0,
        []
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

      it("stores none, one, or several evaluators named at post time", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, evaluator, other, opportunityId } = ctx;

        await commitFirstOpportunity(ctx, OpportunityKind.BusinessProblem, [
          evaluator.address,
          other.address,
        ]);
        expect(await registry.evaluatorCount(opportunityId)).to.equal(2n);
        expect(await registry.evaluatorAt(opportunityId, 0)).to.equal(evaluator.address);
        expect(await registry.isEvaluator(opportunityId, evaluator.address)).to.equal(true);
        expect(await registry.isEvaluator(opportunityId, owner.address)).to.equal(false);

        const noneId = ethers.id("no-evaluators");
        await registry
          .connect(owner)
          .commitOpportunity(noneId, OpportunityKind.OpenFunding, ethers.id("none-hash"), 0, []);
        expect(await registry.evaluatorCount(noneId)).to.equal(0n);
      });

      it("lets the same wallet hold different roles on different postings", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, researcher, evaluator, other } = ctx;

        const ownedByEvaluator = ethers.id("owned-by-evaluator");
        await registry
          .connect(evaluator)
          .commitOpportunity(
            ownedByEvaluator,
            OpportunityKind.BusinessProblem,
            ethers.id("owned-hash"),
            0,
            [owner.address]
          );

        const evaluatedByOwner = ethers.id("evaluated-by-owner");
        await registry
          .connect(researcher)
          .commitOpportunity(
            evaluatedByOwner,
            OpportunityKind.FundingRequest,
            ethers.id("eval-hash"),
            0,
            [owner.address, evaluator.address]
          );
        const proposalOnB = ethers.id("proposal-on-b");
        await registry
          .connect(other)
          .commitProposal(proposalOnB, evaluatedByOwner, ethers.id("p-b"), ethers.id("s-b"));

        expect(await registry.isEvaluator(ownedByEvaluator, evaluator.address)).to.equal(false);
        expect(await registry.isEvaluator(evaluatedByOwner, evaluator.address)).to.equal(true);
        expect(await registry.isEvaluator(evaluatedByOwner, owner.address)).to.equal(true);
        expect((await registry.getOpportunity(ownedByEvaluator)).owner).to.equal(evaluator.address);

        await recordCurrentEvaluation(
          registry,
          owner,
          ethers,
          proposalOnB,
          ethers.id("owner-as-evaluator")
        );
        await recordCurrentEvaluation(
          registry,
          evaluator,
          ethers,
          proposalOnB,
          ethers.id("evaluator-also-reviews")
        );
        expect(await registry.evaluationCount(proposalOnB)).to.equal(2n);
      });

      it("allows the same content hash on two different opportunities", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, opportunityHash, expiresAt } = ctx;

        await commitFirstOpportunity(ctx);
        const secondId = ethers.id("opportunity-2");
        await registry
          .connect(owner)
          .commitOpportunity(secondId, OpportunityKind.OpenFunding, opportunityHash, expiresAt, []);

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
            expiresAt,
            []
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
            expiresAt,
            []
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
            1,
            []
          )
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
        await expect(
          registry.commitOpportunity(
            opportunityId,
            OpportunityKind.BusinessProblem,
            opportunityHash,
            latest.timestamp,
            []
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

      it("rejects a zero, duplicate, or owner evaluator address", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, evaluator, opportunityId, opportunityHash, expiresAt } = ctx;

        await expect(
          registry
            .connect(owner)
            .commitOpportunity(opportunityId, 0, opportunityHash, expiresAt, [ethers.ZeroAddress])
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
        await expect(
          registry
            .connect(owner)
            .commitOpportunity(opportunityId, 0, opportunityHash, expiresAt, [owner.address])
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
        await expect(
          registry
            .connect(owner)
            .commitOpportunity(opportunityId, 0, opportunityHash, expiresAt, [
              evaluator.address,
              evaluator.address,
            ])
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects an opportunity id that is already used by a proposal", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, proposalId } = ctx;

        await commitFirstProposal(ctx);
        await expect(
          registry
            .connect(owner)
            .commitOpportunity(proposalId, OpportunityKind.OpenFunding, ethers.id("other"), 0, [])
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
            BigInt(latest.timestamp) + 2n,
            []
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
          registry
            .connect(researcher)
            .commitProposal(proposalId, opportunityId, proposalHash, solutionHash)
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
          .withArgs(proposalId, opportunityId, researcher.address, proposalHash, solutionHash);
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
            0,
            []
          );
        await registry
          .connect(researcher)
          .commitProposal(
            ethers.id("proposal-a"),
            opportunityId,
            ethers.id("proposal-a-hash"),
            ethers.id("solution-a-hash")
          );
        await registry
          .connect(other)
          .commitProposal(
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
        await registry
          .connect(researcher)
          .commitProposal(laterId, opportunityId, ethers.id("p-after"), ethers.id("s-after"));

        const later = await registry.getProposal(laterId);
        expect(later.opportunityRevisionIndex).to.equal(1n);
        expect(later.opportunityRevisionDigest).to.equal(nextHash);
      });

      it("allows the same value for the proposal hash and the solution hash", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, researcher, opportunityId } = ctx;
        await commitFirstOpportunity(ctx);

        const proposalId = ethers.id("same-hash-proposal");
        const both = ethers.id("one-hash-for-both");
        await registry.connect(researcher).commitProposal(proposalId, opportunityId, both, both);

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
        await registry
          .connect(researcher)
          .updateHashes(proposalId, ethers.id("proposal-hash-later"), ethers.id("solution-hash-later"));

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
          .commitOpportunity(secondOpportunity, OpportunityKind.FundingRequest, ethers.id("fr"), 0, []);
        await registry
          .connect(other)
          .commitProposal(ethers.id("proposal-2"), secondOpportunity, proposalHash, solutionHash);

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
          registry.commitProposal(ZERO_BYTES32, opportunityId, proposalHash, solutionHash)
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
        await expect(
          registry.commitProposal(proposalId, opportunityId, ZERO_BYTES32, solutionHash)
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
        await expect(
          registry.commitProposal(proposalId, opportunityId, proposalHash, ZERO_BYTES32)
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a duplicate proposal id", async function () {
        const ctx = await deployFixture();
        const { registry, researcher, opportunityId, proposalId, proposalHash, solutionHash } = ctx;
        await commitFirstProposal(ctx);
        await expect(
          registry
            .connect(researcher)
            .commitProposal(proposalId, opportunityId, proposalHash, solutionHash)
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
              ethers.id("solution-hash")
            )
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a proposal against a missing opportunity", async function () {
        const ctx = await deployFixture();
        const { registry, researcher, opportunityId, proposalId, proposalHash, solutionHash } = ctx;
        await expect(
          registry
            .connect(researcher)
            .commitProposal(proposalId, opportunityId, proposalHash, solutionHash)
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
            BigInt(latest.timestamp) + 2n,
            []
          );
        await ethers.provider.send("evm_increaseTime", [5]);
        await ethers.provider.send("evm_mine", []);

        await expect(
          registry
            .connect(researcher)
            .commitProposal(proposalId, opportunityId, proposalHash, solutionHash)
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
        const tx = await registry
          .connect(researcher)
          .updateHashes(proposalId, nextProposalHash, nextSolutionHash);
        const timestamp = await timestampOf(ethers, tx);
        const contentHash = combinedHash(ethers, nextProposalHash, nextSolutionHash);

        await expect(tx)
          .to.emit(registry, "HashesUpdated")
          .withArgs(
            proposalId,
            opportunityId,
            researcher.address,
            nextProposalHash,
            nextSolutionHash
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
        const latest = await registry.revisionAt(proposalId, 1);
        expect(latest.proposalHash).to.equal(nextProposalHash);
        expect(latest.solutionHash).to.equal(nextSolutionHash);

        await registry
          .connect(researcher)
          .updateHashes(proposalId, ethers.id("proposal-hash-v3"), ethers.id("solution-hash-v3"));
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

        await registry
          .connect(researcher)
          .updateHashes(proposalId, ethers.id("proposal-hash-v2"), ethers.id("solution-hash-v2"));
        const afterEdit = await registry.getProposal(proposalId);
        expect(afterEdit.opportunityRevisionIndex).to.equal(1n);
        expect(afterEdit.opportunityRevisionDigest).to.equal(nextHash);
      });
    });

    describe("negative", function () {
      it("rejects an unknown proposal", async function () {
        const { ethers, registry, proposalId } = await deployFixture();
        await expect(
          registry.updateHashes(proposalId, ethers.id("p2"), ethers.id("s2"))
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a caller who is not the researcher", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, other, proposalId } = ctx;
        await commitFirstProposal(ctx);
        await expect(
          registry
            .connect(other)
            .updateHashes(proposalId, ethers.id("proposal-hash-v2"), ethers.id("solution-hash-v2"))
        ).to.be.revertedWithCustomError(registry, "AccessDenied");
      });

      it("rejects a zero proposal or solution hash", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, researcher, proposalId } = ctx;
        await commitFirstProposal(ctx);
        await expect(
          registry.connect(researcher).updateHashes(proposalId, ZERO_BYTES32, ethers.id("s2"))
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
        await expect(
          registry.connect(researcher).updateHashes(proposalId, ethers.id("p2"), ZERO_BYTES32)
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a reused proposal or solution hash on the same proposal", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, researcher, proposalId, proposalHash, solutionHash } = ctx;
        await commitFirstProposal(ctx);
        await expect(
          registry
            .connect(researcher)
            .updateHashes(proposalId, proposalHash, ethers.id("solution-hash-v2"))
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
        await expect(
          registry
            .connect(researcher)
            .updateHashes(proposalId, ethers.id("proposal-hash-v2"), solutionHash)
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects an edit after the posting is withdrawn or past its deadline", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, owner, researcher, opportunityId, proposalId } = ctx;
        await commitFirstProposal(ctx);

        await registry.connect(owner).withdrawOpportunity(opportunityId, ethers.id("closed"));
        await expect(
          registry
            .connect(researcher)
            .updateHashes(proposalId, ethers.id("proposal-hash-late"), ethers.id("solution-hash-late"))
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
            BigInt(latest.timestamp) + 3n,
            []
          );
        await registry
          .connect(researcher)
          .commitProposal(lateProposal, lateId, ethers.id("p-early"), ethers.id("s-early"));
        await ethers.provider.send("evm_increaseTime", [10]);
        await ethers.provider.send("evm_mine", []);
        await expect(
          registry
            .connect(researcher)
            .updateHashes(lateProposal, ethers.id("p-late"), ethers.id("s-late"))
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

      it("rejects a second withdrawal and then blocks edits and evaluations", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, researcher, evaluator, proposalId } = ctx;
        await commitFirstProposal(ctx);
        await registry
          .connect(researcher)
          .withdrawProposal(proposalId, ethers.id("proposal-withdraw-reason"));

        await expect(
          registry.connect(researcher).withdrawProposal(proposalId, ethers.id("again"))
        ).to.be.revertedWithCustomError(registry, "InvalidState");
        await expect(
          registry
            .connect(researcher)
            .updateHashes(proposalId, ethers.id("proposal-hash-v2"), ethers.id("solution-hash-v2"))
        ).to.be.revertedWithCustomError(registry, "InvalidState");
        await expect(
          recordCurrentEvaluation(
            registry,
            evaluator,
            ethers,
            proposalId,
            ethers.id("evaluation-hash-v1")
          )
        ).to.be.revertedWithCustomError(registry, "InvalidState");
      });
    });
  });

  describe("recordEvaluation", function () {
    describe("positive", function () {
      it("lets named evaluators record a review against the current revision", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, evaluator, other, proposalId, proposalHash, solutionHash } = ctx;
        await commitFirstProposal(ctx, [evaluator.address, other.address]);

        const firstHash = ethers.id("evaluation-hash-v1");
        const digest = combinedHash(ethers, proposalHash, solutionHash);
        const firstTx = await recordCurrentEvaluation(registry, evaluator, ethers, proposalId, firstHash);
        const firstTimestamp = await timestampOf(ethers, firstTx);

        await expect(firstTx)
          .to.emit(registry, "EvaluationRecorded")
          .withArgs(proposalId, evaluator.address, firstHash, 0, digest);
        await expect(firstTx)
          .to.emit(registry, "EventAnchored")
          .withArgs(
            proposalId,
            EntityType.Evaluation,
            EventType.EvaluationCompleted,
            firstHash,
            ActorRole.Evaluator,
            evaluator.address,
            firstTimestamp
          );

        await recordCurrentEvaluation(registry, other, ethers, proposalId, ethers.id("evaluation-hash-v2"));

        expect(await registry.evaluationCount(proposalId)).to.equal(2n);
        const recorded = await registry.evaluationAt(proposalId, 0);
        expect(recorded.evaluator).to.equal(evaluator.address);
        expect(recorded.contentHash).to.equal(firstHash);
        expect(recorded.revisionIndex).to.equal(0n);
        expect(recorded.revisionDigest).to.equal(digest);
        expect((await registry.getProposal(proposalId)).evaluationLocked).to.equal(true);
      });
    });

    describe("negative", function () {
      it("rejects an unknown proposal", async function () {
        const { ethers, registry, proposalId } = await deployFixture();
        await expect(
          registry.recordEvaluation(proposalId, ethers.id("evaluation-hash-v1"), 0, ethers.id("none"))
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("rejects a wallet that was not named as an evaluator", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, evaluator, other, proposalId } = ctx;
        await commitFirstProposal(ctx, [evaluator.address]);
        await expect(
          recordCurrentEvaluation(registry, other, ethers, proposalId, ethers.id("evaluation-hash-v1"))
        ).to.be.revertedWithCustomError(registry, "AccessDenied");
      });

      it("rejects evaluation when the posting named nobody", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, evaluator, proposalId } = ctx;
        await commitFirstProposal(ctx);
        await expect(
          recordCurrentEvaluation(
            registry,
            evaluator,
            ethers,
            proposalId,
            ethers.id("evaluation-hash-v1")
          )
        ).to.be.revertedWithCustomError(registry, "AccessDenied");
      });

      it("rejects a zero evaluation hash", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, evaluator, proposalId } = ctx;
        await commitFirstProposal(ctx, [evaluator.address]);
        await expect(
          recordCurrentEvaluation(registry, evaluator, ethers, proposalId, ZERO_BYTES32)
        ).to.be.revertedWithCustomError(registry, "InvalidInput");
      });

      it("locks the proposal so the researcher cannot change hashes after a review starts", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, researcher, evaluator, proposalId } = ctx;
        await commitFirstProposal(ctx, [evaluator.address]);
        await recordCurrentEvaluation(
          registry,
          evaluator,
          ethers,
          proposalId,
          ethers.id("evaluation-hash-v1")
        );
        await expect(
          registry
            .connect(researcher)
            .updateHashes(proposalId, ethers.id("proposal-hash-v2"), ethers.id("solution-hash-v2"))
        ).to.be.revertedWithCustomError(registry, "InvalidState");
      });

      it("rejects a review that names a revision that is no longer current", async function () {
        const ctx = await deployFixture();
        const { ethers, registry, researcher, evaluator, proposalId, proposalHash, solutionHash } = ctx;
        await commitFirstProposal(ctx, [evaluator.address]);
        const staleDigest = combinedHash(ethers, proposalHash, solutionHash);

        await registry
          .connect(researcher)
          .updateHashes(proposalId, ethers.id("proposal-hash-v2"), ethers.id("solution-hash-v2"));

        await expect(
          registry
            .connect(evaluator)
            .recordEvaluation(proposalId, ethers.id("evaluation-hash-v1"), 0, staleDigest)
        ).to.be.revertedWithCustomError(registry, "InvalidState");
        await expect(
          registry
            .connect(evaluator)
            .recordEvaluation(proposalId, ethers.id("evaluation-hash-v1"), 1, staleDigest)
        ).to.be.revertedWithCustomError(registry, "InvalidState");

        const current = await currentProposalRevision(registry, ethers, proposalId);
        await registry
          .connect(evaluator)
          .recordEvaluation(proposalId, ethers.id("evaluation-hash-v1"), current.index, current.digest);
        expect((await registry.evaluationAt(proposalId, 0)).revisionIndex).to.equal(1n);
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
