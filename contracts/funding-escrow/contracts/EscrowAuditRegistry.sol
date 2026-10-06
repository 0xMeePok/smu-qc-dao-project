// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AuditRegistryExtensible} from "audit-registry/contracts/AuditRegistryExtensible.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {FundingTerms, FundingEvent, IFundingFactory, IFundedEscrow, IOpenFundingPool} from "./FundingTypes.sol";

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
    mapping(bytes32 postingId => bytes32) public pendingProposalForPosting;
    mapping(bytes32 proposalId => FundingAnchor[]) private _fundingAnchors;
    mapping(bytes32 moderationId => bytes32 recordHash) public moderationRecordHash;
    mapping(bytes32 approachId => bytes32 recordHash) public fundingApproachRecordHash;
    mapping(bytes32 decisionId => bytes32 recordHash) public fundingApproachDecisionHash;
    mapping(address admin => bool) private _moderationAdmins;

    event FundingFactoryConfigured(address indexed factory);
    event ProposalEscrowLinked(bytes32 indexed proposalId, bytes32 indexed postingId, address indexed escrow, bytes32 termsHash);
    event PostingProposalAccepted(bytes32 indexed postingId, bytes32 indexed proposalId, address indexed escrow);
    event PostingFundingPauseChanged(bytes32 indexed postingId, bool paused, address indexed actor);
    event FundingEventAnchored(bytes32 indexed proposalId, address indexed escrow, FundingEvent eventType,
        bytes32 digest, address actor, uint64 timestamp);
    event ModerationAnchored(bytes32 indexed moderationId, bytes32 indexed recordHash,
        address indexed anchoredBy, uint64 anchoredAt);
    event FundingApproachAnchored(bytes32 indexed approachId, bytes32 indexed recordHash,
        address indexed anchoredBy, uint64 anchoredAt);
    event FundingApproachDecisionAnchored(bytes32 indexed decisionId, bytes32 indexed recordHash,
        address indexed anchoredBy, uint64 anchoredAt);
    event ModerationAdminChanged(address indexed admin, bool enabled);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice One-time wiring. The factory must point back to this registry.
    function setFundingFactory(address factory) external onlyOwner {
        if (address(fundingFactory) != address(0) || factory.code.length == 0) revert InvalidInput();
        if (IFundingFactory(factory).auditRegistry() != address(this)) revert InvalidInput();
        address platform = IFundingFactory(factory).platformSigner();
        if (platform == address(0)) revert InvalidInput();
        fundingFactory = IFundingFactory(factory);
        // Keep the service signer authorized by default, with the same revocable role as other moderators.
        _moderationAdmins[platform] = true;
        emit ModerationAdminChanged(platform, true);
        emit FundingFactoryConfigured(factory);
    }

    /// @notice Mirror reversible posting moderation without voiding funded proposals.
    function setPostingFundingPaused(bytes32 postingId, bool paused) external {
        if (address(fundingFactory) == address(0) || msg.sender != fundingFactory.platformSigner()) revert AccessDenied();
        getOpportunity(postingId);
        postingFundingPaused[postingId] = paused;
        emit PostingFundingPauseChanged(postingId, paused, msg.sender);
    }

    /// @notice Grant or revoke the moderation anchoring role; only the registry owner manages it.
    function setModerationAdmin(address admin, bool enabled) external onlyOwner {
        if (admin == address(0)) revert InvalidInput();
        _moderationAdmins[admin] = enabled;
        emit ModerationAdminChanged(admin, enabled);
    }

    /// @notice The current owner is always a moderation admin, alongside explicitly allowed wallets.
    function isModerationAdmin(address actor) public view returns (bool) {
        return actor != address(0) && (actor == owner() || _moderationAdmins[actor]);
    }

    /// @notice Permanently commit one private moderation decision without publishing its contents.
    /// @dev Use an opaque decision ID and hash a versioned canonical record containing the actual moderator,
    /// action, content type/reference, reason and decision timestamp, plus private random salt.
    /// The full record and salt remain restricted to the content author and administrators off-chain.
    /// anchoredBy identifies the submitting admin; anchoredAt is the anchoring block time.
    /// This audit commitment does not change content visibility or escrow custody.
    function anchorModeration(bytes32 moderationId, bytes32 recordHash) external {
        if (!isModerationAdmin(msg.sender)) revert AccessDenied();
        if (moderationId == bytes32(0) || recordHash == bytes32(0)) revert InvalidInput();
        if (moderationRecordHash[moderationId] != bytes32(0)) revert InvalidState();
        moderationRecordHash[moderationId] = recordHash;
        emit ModerationAnchored(moderationId, recordHash, msg.sender, uint64(block.timestamp));
    }

    /// @notice Permanently commit one funding approach without publishing its message.
    /// @dev The first 20 bytes of approachId are the funder, so only that wallet can anchor it.
    /// recordHash is a versioned canonical digest of the funder, proposal, researcher, amount,
    /// currency, scope, message and expiry. The message stays off-chain.
    /// anchoredBy is msg.sender and anchoredAt is the block time. This does not move tokens.
    function anchorFundingApproach(bytes32 approachId, bytes32 recordHash) external {
        if (approachId == bytes32(0) || recordHash == bytes32(0)) revert InvalidInput();
        if (address(bytes20(approachId)) != msg.sender) revert AccessDenied();
        if (fundingApproachRecordHash[approachId] != bytes32(0)) revert InvalidState();
        fundingApproachRecordHash[approachId] = recordHash;
        emit FundingApproachAnchored(approachId, recordHash, msg.sender, uint64(block.timestamp));
    }

    /// @notice Permanently commit funding-approach decisions without publishing their text.
    /// @dev The first 20 bytes of each decisionId are the researcher, so only that wallet can anchor them.
    /// Each recordHash is a versioned digest of the outcome and the accept message or decline reason.
    /// One call anchors the chosen approach and every approach declined because of it.
    /// The text stays off-chain. This does not move tokens.
    function anchorFundingApproachDecisions(bytes32[] calldata decisionIds, bytes32[] calldata recordHashes) external {
        if (decisionIds.length == 0 || decisionIds.length != recordHashes.length || decisionIds.length > 100) revert InvalidInput();
        for (uint256 i = 0; i < decisionIds.length; i++) {
            bytes32 decisionId = decisionIds[i];
            bytes32 recordHash = recordHashes[i];
            if (decisionId == bytes32(0) || recordHash == bytes32(0)) revert InvalidInput();
            if (address(bytes20(decisionId)) != msg.sender) revert AccessDenied();
            if (fundingApproachDecisionHash[decisionId] != bytes32(0)) revert InvalidState();
            fundingApproachDecisionHash[decisionId] = recordHash;
            emit FundingApproachDecisionAnchored(decisionId, recordHash, msg.sender, uint64(block.timestamp));
        }
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
        address pool = fundingFactory.openFundingPoolForPosting(getProposal(proposalId).opportunityId);
        if (pool != address(0) && IOpenFundingPool(pool).offerState(proposalId) != 0) revert FundingTermsFrozen();
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
        bytes32 postingId = getProposal(proposalId).opportunityId;
        bytes32 pending = pendingProposalForPosting[postingId];
        return !postingFundingPaused[postingId] && (pending == bytes32(0) || pending == proposalId);
    }

    function recordOpenFundingDeposit(bytes32 postingId) external {
        if (msg.sender == address(0) || fundingFactory.openFundingPoolForPosting(postingId) != msg.sender) revert AccessDenied();
        postingFundingStarted[postingId] = true;
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
        if (getOpportunity(proposal.opportunityId).kind != OpportunityKind.OpenFunding
            && accepted != bytes32(0) && accepted != proposalId) return false;
        return !proposal.withdrawn && !getOpportunity(proposal.opportunityId).withdrawn;
    }

    /// @notice Only the escrow linked by atomic creation can append its funding audit.
    function recordFundingEvent(bytes32 proposalId, FundingEvent eventType, bytes32 digest, address actor) external {
        if (proposalEscrow[proposalId] != msg.sender || msg.sender == address(0)) revert AccessDenied();
        if (eventType == FundingEvent.EscrowCreated || digest == bytes32(0) || actor == address(0)) revert InvalidInput();
        if (eventType == FundingEvent.Deposit) postingFundingStarted[getProposal(proposalId).opportunityId] = true;
        if (eventType == FundingEvent.Voided) proposalVoided[proposalId] = true;
        bytes32 postingId = getProposal(proposalId).opportunityId;
        if (getOpportunity(postingId).kind != OpportunityKind.OpenFunding) {
            if (eventType == FundingEvent.SelectionLocked) {
                if (pendingProposalForPosting[postingId] != bytes32(0)) revert InvalidState();
                pendingProposalForPosting[postingId] = proposalId;
            } else if (eventType == FundingEvent.SelectionInvalidated || eventType == FundingEvent.Expired
                || eventType == FundingEvent.Cancelled || eventType == FundingEvent.Voided) {
                if (pendingProposalForPosting[postingId] == proposalId) pendingProposalForPosting[postingId] = bytes32(0);
            }
        }
        if (eventType == FundingEvent.TrancheReleased) {
            // Grant opportunities support several independent awards. A payout
            // must never invalidate their other selected proposals.
            if (getOpportunity(postingId).kind == OpportunityKind.OpenFunding) {
                _record(proposalId, eventType, digest, actor);
                return;
            }
            bytes32 accepted = acceptedProposalForPosting[postingId];
            if (accepted != bytes32(0) && accepted != proposalId) revert InvalidState();
            if (accepted == bytes32(0)) {
                acceptedProposalForPosting[postingId] = proposalId;
                pendingProposalForPosting[postingId] = bytes32(0);
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
