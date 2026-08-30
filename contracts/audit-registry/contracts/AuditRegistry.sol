// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title AuditRegistry
/// @notice Anchors opportunity, proposal, and evaluation hashes with an append-only trail.
contract AuditRegistry {
    error AccessDenied();
    error InvalidInput();
    error InvalidState();

    enum EntityType {
        Opportunity,
        Proposal,
        Evaluation
    }

    enum EventType {
        OpportunityPosted,
        OpportunityUpdated,
        OpportunityWithdrawn,
        ProposalSubmitted,
        ProposalUpdated,
        ProposalWithdrawn,
        EvaluationCompleted
    }

    enum ActorRole {
        ProblemOwner,
        Funder,
        Researcher,
        Evaluator
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

    // Latest view of a submission. Who filed it, which posting it sits on,
    // and the current proposal + solution hashes. Older pairs live in `_revisions`.
    struct Proposal {
        address researcher;
        bytes32 opportunityId;
        bytes32 proposalHash;
        bytes32 solutionHash;
        uint64 createdAt;
        uint64 updatedAt;
        bool evaluationLocked;
        bool withdrawn;
        bool exists;
    }

    struct Revision {
        bytes32 proposalHash;
        bytes32 solutionHash;
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

    // Official review from a named evaluator, tied to the revision they saw.
    // The hash is the off-chain write-up (score, comments, etc.).
    struct EvaluationRecord {
        address evaluator;
        bytes32 contentHash;
        uint32 revisionIndex;
        bytes32 revisionDigest;
        uint64 createdAt;
    }

    uint256 public constant MAX_EVALUATORS = 32;

    mapping(bytes32 opportunityId => Opportunity) private _opportunities;
    mapping(bytes32 opportunityId => HashRevision[]) private _opportunityRevisions;
    mapping(bytes32 opportunityId => mapping(bytes32 contentHash => bool)) private _usedOpportunityHashes;
    mapping(bytes32 opportunityId => address[]) private _evaluators;
    mapping(bytes32 opportunityId => mapping(address evaluator => bool)) public isEvaluator;
    mapping(bytes32 proposalId => Proposal) private _proposals;
    mapping(bytes32 proposalId => Revision[]) private _revisions;
    mapping(bytes32 proposalId => mapping(bytes32 contentHash => bool)) private _usedHashes;
    mapping(bytes32 proposalId => EvaluationRecord[]) private _evaluations;
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
        bytes32 solutionHash
    );
    event HashesUpdated(
        bytes32 indexed proposalId,
        bytes32 indexed opportunityId,
        address indexed researcher,
        bytes32 proposalHash,
        bytes32 solutionHash
    );
    event ProposalWithdrawn(
        bytes32 indexed proposalId,
        address indexed researcher,
        bytes32 evidenceHash
    );
    event EvaluatorAdded(bytes32 indexed opportunityId, address indexed evaluator);
    event EvaluationRecorded(
        bytes32 indexed proposalId,
        address indexed evaluator,
        bytes32 contentHash,
        uint32 revisionIndex,
        bytes32 revisionDigest
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

    function commitOpportunity(
        bytes32 opportunityId,
        OpportunityKind kind,
        bytes32 contentHash,
        uint64 expiresAt,
        address[] calldata evaluators
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
        _registerEvaluators(opportunityId, evaluators);

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
        _proposals[proposalId] = Proposal({
            researcher: msg.sender,
            opportunityId: opportunityId,
            proposalHash: proposalHash,
            solutionHash: solutionHash,
            createdAt: timestamp,
            updatedAt: timestamp,
            evaluationLocked: false,
            withdrawn: false,
            exists: true
        });

        _appendRevision(proposalId, proposalHash, solutionHash, timestamp);
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
            solutionHash
        );
    }

    function updateHashes(
        bytes32 proposalId,
        bytes32 proposalHash,
        bytes32 solutionHash
    ) external {
        Proposal storage item = _proposal(proposalId);
        if (msg.sender != item.researcher) revert AccessDenied();
        if (item.withdrawn || item.evaluationLocked || !_submissionOpen(item.opportunityId)) {
            revert InvalidState();
        }
        if (proposalHash == bytes32(0) || solutionHash == bytes32(0)) {
            revert InvalidInput();
        }

        uint64 timestamp = uint64(block.timestamp);
        item.proposalHash = proposalHash;
        item.solutionHash = solutionHash;
        item.updatedAt = timestamp;

        _appendRevision(proposalId, proposalHash, solutionHash, timestamp);
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
            solutionHash
        );
    }

    // Withdraw is still allowed after a review. A named evaluator may say the
    // solution is not feasible; the researcher can then close the submission.
    // Hash edits stay locked. The evaluation records stay on the trail.
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

    function recordEvaluation(bytes32 proposalId, bytes32 evaluationHash) external {
        Proposal storage item = _proposal(proposalId);
        Opportunity storage parent = _opportunity(item.opportunityId);
        if (item.withdrawn || parent.withdrawn) revert InvalidState();
        if (!isEvaluator[item.opportunityId][msg.sender]) revert AccessDenied();
        if (evaluationHash == bytes32(0)) revert InvalidInput();

        uint256 revisionIndex = _revisions[proposalId].length - 1;
        bytes32 revisionDigest = keccak256(abi.encode(item.proposalHash, item.solutionHash));
        uint64 timestamp = uint64(block.timestamp);

        item.evaluationLocked = true;
        item.updatedAt = timestamp;
        _evaluations[proposalId].push(
            EvaluationRecord(
                msg.sender,
                evaluationHash,
                uint32(revisionIndex),
                revisionDigest,
                timestamp
            )
        );
        _anchor(
            proposalId,
            EntityType.Evaluation,
            EventType.EvaluationCompleted,
            evaluationHash,
            ActorRole.Evaluator,
            msg.sender,
            timestamp
        );
        emit EvaluationRecorded(
            proposalId,
            msg.sender,
            evaluationHash,
            uint32(revisionIndex),
            revisionDigest
        );
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

    function evaluatorCount(bytes32 opportunityId) external view returns (uint256) {
        _opportunity(opportunityId);
        return _evaluators[opportunityId].length;
    }

    function evaluatorAt(bytes32 opportunityId, uint256 index) external view returns (address) {
        _opportunity(opportunityId);
        return _evaluators[opportunityId][index];
    }

    function evaluationCount(bytes32 proposalId) external view returns (uint256) {
        _proposal(proposalId);
        return _evaluations[proposalId].length;
    }

    function evaluationAt(
        bytes32 proposalId,
        uint256 index
    ) external view returns (EvaluationRecord memory) {
        _proposal(proposalId);
        return _evaluations[proposalId][index];
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

    function _registerEvaluators(bytes32 opportunityId, address[] calldata evaluators) private {
        if (evaluators.length > MAX_EVALUATORS) revert InvalidInput();

        for (uint256 index; index < evaluators.length; ++index) {
            address evaluator = evaluators[index];
            if (
                evaluator == address(0)
                    || evaluator == msg.sender
                    || isEvaluator[opportunityId][evaluator]
            ) {
                revert InvalidInput();
            }
            isEvaluator[opportunityId][evaluator] = true;
            _evaluators[opportunityId].push(evaluator);
            emit EvaluatorAdded(opportunityId, evaluator);
        }
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
        _revisions[proposalId].push(Revision(proposalHash, solutionHash, timestamp));
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
