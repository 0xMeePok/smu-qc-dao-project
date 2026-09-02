// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract AuditRegistry {
    error AccessDenied();
    error InvalidInput();
    error InvalidState();

    enum EntityType {
        Opportunity,
        Proposal
    }

    enum EventType {
        OpportunityPosted,
        OpportunityUpdated,
        OpportunityWithdrawn,
        ProposalSubmitted,
        ProposalUpdated,
        ProposalWithdrawn
    }

    enum ActorRole {
        ProblemOwner,
        Funder,
        Researcher
    }

    enum OpportunityKind {
        BusinessProblem,
        OpenFunding,
        FundingRequest
    }

    struct Opportunity {
        address owner;
        OpportunityKind kind;
        bytes32 contentHash;
        uint64 createdAt;
        uint64 updatedAt;
        uint64 expiresAt;
        bool withdrawn;
        bool exists;
    }

    struct Proposal {
        address researcher;
        bytes32 opportunityId;
        uint32 opportunityRevisionIndex;
        bytes32 opportunityRevisionDigest;
        bytes32 proposalHash;
        bytes32 solutionHash;
        uint64 createdAt;
        uint64 updatedAt;
        bool withdrawn;
        bool exists;
    }

    struct Revision {
        bytes32 proposalHash;
        bytes32 solutionHash;
        uint32 opportunityRevisionIndex;
        bytes32 opportunityRevisionDigest;
        uint64 createdAt;
    }

    struct HashRevision {
        bytes32 contentHash;
        uint64 createdAt;
    }

    struct Anchor {
        EntityType entityType;
        EventType eventType;
        bytes32 contentHash;
        ActorRole actorRole;
        address actor;
        uint64 timestamp;
    }

    mapping(bytes32 opportunityId => Opportunity) private _opportunities;
    mapping(bytes32 opportunityId => HashRevision[]) private _opportunityRevisions;
    mapping(bytes32 opportunityId => mapping(bytes32 contentHash => bool)) private _usedOpportunityHashes;
    mapping(bytes32 proposalId => Proposal) private _proposals;
    mapping(bytes32 proposalId => Revision[]) private _revisions;
    mapping(bytes32 proposalId => mapping(bytes32 contentHash => bool)) private _usedHashes;
    mapping(bytes32 entityId => Anchor[]) private _anchors;

    event OpportunityCommitted(
        bytes32 indexed opportunityId,
        OpportunityKind kind,
        address indexed owner,
        bytes32 contentHash,
        uint64 expiresAt
    );
    event OpportunityUpdated(
        bytes32 indexed opportunityId,
        address indexed owner,
        bytes32 contentHash,
        uint64 expiresAt
    );
    event OpportunityWithdrawn(
        bytes32 indexed opportunityId,
        address indexed owner,
        bytes32 evidenceHash
    );
    event ProposalCommitted(
        bytes32 indexed proposalId,
        bytes32 indexed opportunityId,
        address indexed researcher,
        bytes32 proposalHash,
        bytes32 solutionHash,
        uint32 opportunityRevisionIndex,
        bytes32 opportunityRevisionDigest
    );
    event HashesUpdated(
        bytes32 indexed proposalId,
        bytes32 indexed opportunityId,
        address indexed researcher,
        bytes32 proposalHash,
        bytes32 solutionHash,
        uint32 opportunityRevisionIndex,
        bytes32 opportunityRevisionDigest
    );
    event ProposalWithdrawn(
        bytes32 indexed proposalId,
        address indexed researcher,
        bytes32 evidenceHash
    );
    event EventAnchored(
        bytes32 indexed entityId,
        EntityType entityType,
        EventType eventType,
        bytes32 contentHash,
        ActorRole actorRole,
        address actor,
        uint64 timestamp
    );

    // Post an opportunity.
    function commitOpportunity(
        bytes32 opportunityId,
        OpportunityKind kind,
        bytes32 contentHash,
        uint64 expiresAt
    ) external {
        if (
            opportunityId == bytes32(0)
                || contentHash == bytes32(0)
                || _idTaken(opportunityId)
                || !_validExpiry(expiresAt)
        ) {
            revert InvalidInput();
        }

        uint64 timestamp = uint64(block.timestamp);
        _opportunities[opportunityId] = Opportunity({
            owner: msg.sender,
            kind: kind,
            contentHash: contentHash,
            createdAt: timestamp,
            updatedAt: timestamp,
            expiresAt: expiresAt,
            withdrawn: false,
            exists: true
        });
        _appendOpportunityRevision(opportunityId, contentHash, timestamp);
        _anchor(
            opportunityId,
            EntityType.Opportunity,
            EventType.OpportunityPosted,
            contentHash,
            _roleFor(kind),
            msg.sender,
            timestamp
        );

        emit OpportunityCommitted(opportunityId, kind, msg.sender, contentHash, expiresAt);
    }

    // Replace the opportunity hash and expiry while the posting is still live.
    function updateOpportunity(
        bytes32 opportunityId,
        bytes32 contentHash,
        uint64 expiresAt
    ) external {
        Opportunity storage item = _opportunity(opportunityId);
        if (msg.sender != item.owner) revert AccessDenied();
        if (item.withdrawn || _expired(item)) revert InvalidState();
        if (contentHash == bytes32(0) || !_validExpiry(expiresAt)) revert InvalidInput();

        uint64 timestamp = uint64(block.timestamp);
        item.contentHash = contentHash;
        item.expiresAt = expiresAt;
        item.updatedAt = timestamp;

        _appendOpportunityRevision(opportunityId, contentHash, timestamp);
        _anchor(
            opportunityId,
            EntityType.Opportunity,
            EventType.OpportunityUpdated,
            contentHash,
            _roleFor(item.kind),
            msg.sender,
            timestamp
        );

        emit OpportunityUpdated(opportunityId, msg.sender, contentHash, expiresAt);
    }

    // Withdraw an opportunity so new proposals cannot be filed.
    function withdrawOpportunity(bytes32 opportunityId, bytes32 evidenceHash) external {
        Opportunity storage item = _opportunity(opportunityId);
        if (msg.sender != item.owner) revert AccessDenied();
        if (evidenceHash == bytes32(0)) revert InvalidInput();
        if (item.withdrawn) revert InvalidState();

        uint64 timestamp = uint64(block.timestamp);
        item.withdrawn = true;
        item.updatedAt = timestamp;

        _anchor(
            opportunityId,
            EntityType.Opportunity,
            EventType.OpportunityWithdrawn,
            evidenceHash,
            _roleFor(item.kind),
            msg.sender,
            timestamp
        );

        emit OpportunityWithdrawn(opportunityId, msg.sender, evidenceHash);
    }

    // File a proposal against a live opportunity.
    function commitProposal(
        bytes32 proposalId,
        bytes32 opportunityId,
        bytes32 proposalHash,
        bytes32 solutionHash
    ) external {
        if (
            proposalId == bytes32(0)
                || proposalHash == bytes32(0)
                || solutionHash == bytes32(0)
                || _idTaken(proposalId)
        ) {
            revert InvalidInput();
        }
        if (!_submissionOpen(opportunityId)) revert InvalidState();

        uint64 timestamp = uint64(block.timestamp);
        (uint32 opportunityRevisionIndex, bytes32 opportunityRevisionDigest) =
            _currentOpportunityRevision(opportunityId);
        _proposals[proposalId] = Proposal({
            researcher: msg.sender,
            opportunityId: opportunityId,
            opportunityRevisionIndex: opportunityRevisionIndex,
            opportunityRevisionDigest: opportunityRevisionDigest,
            proposalHash: proposalHash,
            solutionHash: solutionHash,
            createdAt: timestamp,
            updatedAt: timestamp,
            withdrawn: false,
            exists: true
        });

        _appendRevision(
            proposalId,
            proposalHash,
            solutionHash,
            opportunityRevisionIndex,
            opportunityRevisionDigest,
            timestamp
        );
        _anchor(
            proposalId,
            EntityType.Proposal,
            EventType.ProposalSubmitted,
            keccak256(abi.encode(proposalHash, solutionHash)),
            ActorRole.Researcher,
            msg.sender,
            timestamp
        );

        emit ProposalCommitted(
            proposalId,
            opportunityId,
            msg.sender,
            proposalHash,
            solutionHash,
            opportunityRevisionIndex,
            opportunityRevisionDigest
        );
    }

    // Replace the current proposal and solution hashes while the proposal is live.
    function updateHashes(
        bytes32 proposalId,
        bytes32 proposalHash,
        bytes32 solutionHash
    ) external {
        Proposal storage item = _proposal(proposalId);
        if (msg.sender != item.researcher) revert AccessDenied();
        if (item.withdrawn || !_submissionOpen(item.opportunityId)) {
            revert InvalidState();
        }
        if (proposalHash == bytes32(0) || solutionHash == bytes32(0)) {
            revert InvalidInput();
        }

        uint64 timestamp = uint64(block.timestamp);
        (uint32 opportunityRevisionIndex, bytes32 opportunityRevisionDigest) =
            _currentOpportunityRevision(item.opportunityId);
        item.proposalHash = proposalHash;
        item.solutionHash = solutionHash;
        item.opportunityRevisionIndex = opportunityRevisionIndex;
        item.opportunityRevisionDigest = opportunityRevisionDigest;
        item.updatedAt = timestamp;

        _appendRevision(
            proposalId,
            proposalHash,
            solutionHash,
            opportunityRevisionIndex,
            opportunityRevisionDigest,
            timestamp
        );
        _anchor(
            proposalId,
            EntityType.Proposal,
            EventType.ProposalUpdated,
            keccak256(abi.encode(proposalHash, solutionHash)),
            ActorRole.Researcher,
            msg.sender,
            timestamp
        );

        emit HashesUpdated(
            proposalId,
            item.opportunityId,
            msg.sender,
            proposalHash,
            solutionHash,
            opportunityRevisionIndex,
            opportunityRevisionDigest
        );
    }

    // Withdraw a proposal.
    function withdrawProposal(bytes32 proposalId, bytes32 evidenceHash) external {
        Proposal storage item = _proposal(proposalId);
        if (msg.sender != item.researcher) revert AccessDenied();
        if (evidenceHash == bytes32(0)) revert InvalidInput();
        if (item.withdrawn) revert InvalidState();

        uint64 timestamp = uint64(block.timestamp);
        item.withdrawn = true;
        item.updatedAt = timestamp;

        _anchor(
            proposalId,
            EntityType.Proposal,
            EventType.ProposalWithdrawn,
            evidenceHash,
            ActorRole.Researcher,
            msg.sender,
            timestamp
        );

        emit ProposalWithdrawn(proposalId, msg.sender, evidenceHash);
    }

    function getOpportunity(bytes32 opportunityId) external view returns (Opportunity memory) {
        return _opportunity(opportunityId);
    }

    function opportunityRevisionCount(bytes32 opportunityId) external view returns (uint256) {
        _opportunity(opportunityId);
        return _opportunityRevisions[opportunityId].length;
    }

    function opportunityRevisionAt(
        bytes32 opportunityId,
        uint256 index
    ) external view returns (HashRevision memory) {
        _opportunity(opportunityId);
        return _opportunityRevisions[opportunityId][index];
    }

    function getProposal(bytes32 proposalId) external view returns (Proposal memory) {
        return _proposal(proposalId);
    }

    function revisionCount(bytes32 proposalId) external view returns (uint256) {
        _proposal(proposalId);
        return _revisions[proposalId].length;
    }

    function revisionAt(
        bytes32 proposalId,
        uint256 index
    ) external view returns (Revision memory) {
        _proposal(proposalId);
        return _revisions[proposalId][index];
    }

    function anchorCount(bytes32 entityId) external view returns (uint256) {
        _requireEntity(entityId);
        return _anchors[entityId].length;
    }

    function anchorAt(
        bytes32 entityId,
        uint256 index
    ) external view returns (Anchor memory) {
        _requireEntity(entityId);
        return _anchors[entityId][index];
    }

    function _currentOpportunityRevision(bytes32 opportunityId)
        private
        view
        returns (uint32 index, bytes32 digest)
    {
        HashRevision[] storage revisions = _opportunityRevisions[opportunityId];
        index = uint32(revisions.length - 1);
        digest = revisions[index].contentHash;
    }

    function _appendOpportunityRevision(
        bytes32 opportunityId,
        bytes32 contentHash,
        uint64 timestamp
    ) private {
        if (_usedOpportunityHashes[opportunityId][contentHash]) revert InvalidInput();
        _usedOpportunityHashes[opportunityId][contentHash] = true;
        _opportunityRevisions[opportunityId].push(HashRevision(contentHash, timestamp));
    }

    function _appendRevision(
        bytes32 proposalId,
        bytes32 proposalHash,
        bytes32 solutionHash,
        uint32 opportunityRevisionIndex,
        bytes32 opportunityRevisionDigest,
        uint64 timestamp
    ) private {
        if (
            _usedHashes[proposalId][proposalHash]
                || _usedHashes[proposalId][solutionHash]
        ) {
            revert InvalidInput();
        }

        _usedHashes[proposalId][proposalHash] = true;
        _usedHashes[proposalId][solutionHash] = true;
        _revisions[proposalId].push(
            Revision(
                proposalHash,
                solutionHash,
                opportunityRevisionIndex,
                opportunityRevisionDigest,
                timestamp
            )
        );
    }

    function _anchor(
        bytes32 entityId,
        EntityType entityType,
        EventType eventType,
        bytes32 contentHash,
        ActorRole actorRole,
        address actor,
        uint64 timestamp
    ) private {
        _anchors[entityId].push(
            Anchor(entityType, eventType, contentHash, actorRole, actor, timestamp)
        );
        emit EventAnchored(
            entityId,
            entityType,
            eventType,
            contentHash,
            actorRole,
            actor,
            timestamp
        );
    }

    function _opportunity(bytes32 opportunityId) private view returns (Opportunity storage item) {
        item = _opportunities[opportunityId];
        if (!item.exists) revert InvalidInput();
    }

    function _proposal(bytes32 proposalId) private view returns (Proposal storage item) {
        item = _proposals[proposalId];
        if (!item.exists) revert InvalidInput();
    }

    function _requireEntity(bytes32 entityId) private view {
        if (!_opportunities[entityId].exists && !_proposals[entityId].exists) {
            revert InvalidInput();
        }
    }

    function _idTaken(bytes32 id) private view returns (bool) {
        return _opportunities[id].exists || _proposals[id].exists;
    }

    function _submissionOpen(bytes32 opportunityId) private view returns (bool) {
        Opportunity storage item = _opportunities[opportunityId];
        if (!item.exists || item.withdrawn) return false;
        return !_expired(item);
    }

    function _expired(Opportunity storage item) private view returns (bool) {
        return item.expiresAt != 0 && block.timestamp >= item.expiresAt;
    }

    function _validExpiry(uint64 expiresAt) private view returns (bool) {
        return expiresAt == 0 || expiresAt > block.timestamp;
    }

    function _roleFor(OpportunityKind kind) private pure returns (ActorRole) {
        if (kind == OpportunityKind.BusinessProblem) return ActorRole.ProblemOwner;
        if (kind == OpportunityKind.OpenFunding) return ActorRole.Funder;
        return ActorRole.Researcher;
    }
}
