// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AuditRegistryExtensible} from "audit-registry/contracts/AuditRegistryExtensible.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {FundingTerms, FundingEvent, IFundingFactory, IFundedEscrow} from "./FundingTypes.sol";

/// @notice Registry deployment whose proposals always receive a canonical escrow.
contract EscrowAuditRegistry is AuditRegistryExtensible, Ownable2Step {
    error FundingTermsRequired();
    error FundingTermsFrozen();

    struct FundingAnchor {
        FundingEvent eventType;
        bytes32 digest;
        address actor;
        uint64 timestamp;
    }

    IFundingFactory public fundingFactory;
    mapping(bytes32 proposalId => address) public proposalEscrow;
    mapping(bytes32 proposalId => bool) public proposalVoided;
    mapping(bytes32 postingId => bool) public postingFundingStarted;
    mapping(bytes32 postingId => bool) public postingFundingPaused;
    mapping(bytes32 postingId => bytes32) public acceptedProposalForPosting;
    mapping(bytes32 proposalId => FundingAnchor[]) private _fundingAnchors;

    event FundingFactoryConfigured(address indexed factory);
    event ProposalEscrowLinked(bytes32 indexed proposalId, bytes32 indexed postingId, address indexed escrow, bytes32 termsHash);
    event PostingProposalAccepted(bytes32 indexed postingId, bytes32 indexed proposalId, address indexed escrow);
    event PostingFundingPauseChanged(bytes32 indexed postingId, bool paused, address indexed actor);
    event FundingEventAnchored(bytes32 indexed proposalId, address indexed escrow, FundingEvent eventType,
        bytes32 digest, address actor, uint64 timestamp);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice One-time wiring. The factory must point back to this registry.
    function setFundingFactory(address factory) external onlyOwner {
        if (address(fundingFactory) != address(0) || factory.code.length == 0) revert InvalidInput();
        if (IFundingFactory(factory).auditRegistry() != address(this)) revert InvalidInput();
        fundingFactory = IFundingFactory(factory);
        emit FundingFactoryConfigured(factory);
    }

    /// @notice Mirror reversible posting moderation without voiding funded proposals.
    function setPostingFundingPaused(bytes32 postingId, bool paused) external {
        if (address(fundingFactory) == address(0) || msg.sender != fundingFactory.platformSigner()) revert AccessDenied();
        getOpportunity(postingId);
        postingFundingPaused[postingId] = paused;
        emit PostingFundingPauseChanged(postingId, paused, msg.sender);
    }

    /// @dev Deliberately disable the old entry point on this linked deployment.
    function commitProposal(bytes32, bytes32, bytes32, bytes32, uint32) public pure override {
        revert FundingTermsRequired();
    }

    function commitProposalWithEscrow(
        bytes32 proposalId, bytes32 opportunityId, bytes32 proposalHash, bytes32 solutionHash,
        uint32 expectedOpportunityRevisionIndex, FundingTerms calldata terms
    ) external returns (address escrow) {
        if (address(fundingFactory) == address(0) || acceptedProposalForPosting[opportunityId] != bytes32(0)
            || postingFundingPaused[opportunityId]) revert InvalidState();
        super.commitProposal(proposalId, opportunityId, proposalHash, solutionHash, expectedOpportunityRevisionIndex);
        escrow = fundingFactory.createEscrow(proposalId, terms);
        proposalEscrow[proposalId] = escrow;
        bytes32 termsHash = keccak256(abi.encode(terms));
        _record(proposalId, FundingEvent.EscrowCreated, termsHash, msg.sender);
        emit ProposalEscrowLinked(proposalId, opportunityId, escrow, termsHash);
    }

    function updateHashes(bytes32 proposalId, bytes32 proposalHash, bytes32 solutionHash, uint32 expectedRevision)
        public override
    {
        if (proposalVoided[proposalId]) revert InvalidState();
        address escrow = proposalEscrow[proposalId];
        if (escrow != address(0) && IFundedEscrow(escrow).totalDeposited() != 0) revert FundingTermsFrozen();
        super.updateHashes(proposalId, proposalHash, solutionHash, expectedRevision);
    }

    function updateOpportunity(bytes32 postingId, bytes32 contentHash, uint64 expiresAt) public override {
        if (postingFundingStarted[postingId]) revert FundingTermsFrozen();
        // Escrow expiries are immutable even before funding. Prevent divergence
        // from the posting; edits may change content, but cannot change expiry.
        if (getOpportunity(postingId).expiresAt != expiresAt) revert FundingTermsFrozen();
        super.updateOpportunity(postingId, contentHash, expiresAt);
    }

    function isFundingActive(bytes32 proposalId, address escrow) external view returns (bool) {
        if (!_isFundingCurrent(proposalId, escrow)) return false;
        return !postingFundingPaused[getProposal(proposalId).opportunityId];
    }

    /// @notice Reversible moderation never gives permission to permanently void custody.
    function isFundingInvalidated(bytes32 proposalId, address escrow) external view returns (bool) {
        if (escrow == address(0) || proposalEscrow[proposalId] != escrow) return false;
        return !_isFundingCurrent(proposalId, escrow);
    }

    function _isFundingCurrent(bytes32 proposalId, address escrow) private view returns (bool) {
        if (escrow == address(0) || proposalEscrow[proposalId] != escrow || proposalVoided[proposalId]) return false;
        Proposal memory proposal = getProposal(proposalId);
        bytes32 accepted = acceptedProposalForPosting[proposal.opportunityId];
        if (accepted != bytes32(0) && accepted != proposalId) return false;
        return !proposal.withdrawn && !getOpportunity(proposal.opportunityId).withdrawn;
    }

    /// @notice Only the escrow linked by atomic creation can append its funding audit.
    function recordFundingEvent(bytes32 proposalId, FundingEvent eventType, bytes32 digest, address actor) external {
        if (proposalEscrow[proposalId] != msg.sender || msg.sender == address(0)) revert AccessDenied();
        if (eventType == FundingEvent.EscrowCreated || digest == bytes32(0) || actor == address(0)) revert InvalidInput();
        if (eventType == FundingEvent.Deposit) postingFundingStarted[getProposal(proposalId).opportunityId] = true;
        if (eventType == FundingEvent.Voided) proposalVoided[proposalId] = true;
        if (eventType == FundingEvent.TrancheReleased) {
            bytes32 postingId = getProposal(proposalId).opportunityId;
            bytes32 accepted = acceptedProposalForPosting[postingId];
            if (accepted != bytes32(0) && accepted != proposalId) revert InvalidState();
            if (accepted == bytes32(0)) {
                acceptedProposalForPosting[postingId] = proposalId;
                emit PostingProposalAccepted(postingId, proposalId, msg.sender);
            }
        }
        _record(proposalId, eventType, digest, actor);
    }

    function fundingAnchorCount(bytes32 proposalId) external view returns (uint256) { return _fundingAnchors[proposalId].length; }
    function fundingAnchorAt(bytes32 proposalId, uint256 index) external view returns (FundingAnchor memory) {
        return _fundingAnchors[proposalId][index];
    }

    function _record(bytes32 proposalId, FundingEvent eventType, bytes32 digest, address actor) private {
        uint64 timestamp = uint64(block.timestamp);
        _fundingAnchors[proposalId].push(FundingAnchor(eventType, digest, actor, timestamp));
        emit FundingEventAnchored(proposalId, proposalEscrow[proposalId], eventType, digest, actor, timestamp);
    }
}
