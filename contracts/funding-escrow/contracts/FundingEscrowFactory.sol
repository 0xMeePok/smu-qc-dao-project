// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FundingEscrowDeployer} from "./FundingEscrowDeployer.sol";
import {OpenFundingPoolDeployer} from "./OpenFundingPoolDeployer.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {TokenDecimals} from "./TokenDecimals.sol";
import {AuditRegistry} from "audit-registry/contracts/AuditRegistry.sol";
import {FundingTerms, EscrowInit, IOpenFundingPool} from "./FundingTypes.sol";

/// @notice Canonical escrow registry: each proposal has its own custody and ledger.
/// @dev Only the linked registry creates escrows, with owners derived from its records.
contract FundingEscrowFactory is Ownable2Step {
    using EnumerableSet for EnumerableSet.AddressSet;
    error AccessDenied();
    error InvalidInput();
    error UnsupportedToken();
    error ProposalAlreadyExists();
    error OwnershipRenunciationDisabled();

    uint256 public constant BPS_SCALE = 10_000;
    uint8 public constant MAX_TOKEN_DECIMALS = TokenDecimals.MAX_DECIMALS;
    address public immutable platformSigner;
    address public immutable auditRegistry;
    FundingEscrowDeployer public immutable escrowDeployer;
    OpenFundingPoolDeployer public immutable openFundingPoolDeployer;
    mapping(address admin => bool) private _escrowAdmins;
    uint16 public feeBps;
    mapping(address token => bool) public allowedTokens;
    mapping(address token => uint8) public tokenDecimals;
    mapping(address token => bool) private _decimalsRecorded;
    EnumerableSet.AddressSet private _listedTokens;
    mapping(bytes32 proposalId => address escrow) public escrowForProposal;
    mapping(bytes32 postingId => address pool) public openFundingPoolForPosting;

    event EscrowCreated(
        bytes32 indexed postingId, bytes32 indexed proposalId, address indexed escrow,
        address problemOwner, address token, uint256 fundingTarget, uint64 expiresAt,
        address feeRecipient, uint16 feeBps
    );
    event FeeBpsUpdated(uint16 previousBps, uint16 newBps);
    event TokenListingChanged(address indexed token, bool allowed, uint8 decimals);
    event EscrowAdminChanged(address indexed admin, bool enabled);
    event OpenFundingPoolCreated(bytes32 indexed postingId, address indexed pool, address indexed owner, address token);

    constructor(address initialOwner, address platformSigner_, address[] memory tokens, uint16 feeBps_, address auditRegistry_)
        Ownable(initialOwner)
    {
        if (platformSigner_ == address(0) || tokens.length == 0 || feeBps_ > BPS_SCALE || auditRegistry_.code.length == 0) revert InvalidInput();
        platformSigner = platformSigner_;
        auditRegistry = auditRegistry_;
        escrowDeployer = new FundingEscrowDeployer(address(this));
        openFundingPoolDeployer = new OpenFundingPoolDeployer(address(this));
        feeBps = feeBps_;
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            if (token.code.length == 0 || allowedTokens[token]) revert InvalidInput();
            _recordDecimals(token);
            allowedTokens[token] = true;
            _listedTokens.add(token);
            emit TokenListingChanged(token, true, tokenDecimals[token]);
        }
    }

    /// @notice Delisting blocks new risk, never exit of funds already in custody.
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        if (token == address(0) || (allowed && token.code.length == 0)) revert InvalidInput();
        if (allowedTokens[token] == allowed) revert InvalidInput();
        // Delisting must remain possible even if metadata breaks after listing.
        if (allowed) _recordDecimals(token);
        allowedTokens[token] = allowed;
        if (allowed) _listedTokens.add(token);
        else _listedTokens.remove(token);
        emit TokenListingChanged(token, allowed, tokenDecimals[token]);
    }

    function _recordDecimals(address token) private {
        if (_decimalsRecorded[token]) {
            TokenDecimals.requireUnchanged(token, tokenDecimals[token]);
        } else {
            tokenDecimals[token] = TokenDecimals.read(token);
            _decimalsRecorded[token] = true;
        }
    }

    function getAllowedTokens() external view returns (address[] memory) { return _listedTokens.values(); }

    function setEscrowAdmin(address admin, bool enabled) external onlyOwner {
        if (admin == address(0)) revert InvalidInput();
        _escrowAdmins[admin] = enabled;
        emit EscrowAdminChanged(admin, enabled);
    }

    function isEscrowAdmin(address actor) external view returns (bool) { return actor == owner() || _escrowAdmins[actor]; }

    /// @notice Changes fees for future escrows; existing funding terms are immutable.
    function setFeeBps(uint16 newBps) external onlyOwner {
        if (newBps > BPS_SCALE) revert InvalidInput();
        uint16 previous = feeBps;
        feeBps = newBps;
        emit FeeBpsUpdated(previous, newBps);
    }

    /// @dev A zero owner would prevent future escrows from receiving a valid fee recipient.
    function renounceOwnership() public view override onlyOwner { revert OwnershipRenunciationDisabled(); }

    function createOpenFundingPool(bytes32 postingId, address token) external returns (address pool) {
        AuditRegistry.Opportunity memory posting = AuditRegistry(auditRegistry).getOpportunity(postingId);
        if (posting.owner != msg.sender) revert AccessDenied();
        if (posting.kind != AuditRegistry.OpportunityKind.OpenFunding || posting.withdrawn || posting.expiresAt <= block.timestamp
            || openFundingPoolForPosting[postingId] != address(0)) revert InvalidInput();
        if (!allowedTokens[token]) revert UnsupportedToken();
        TokenDecimals.requireUnchanged(token, tokenDecimals[token]);
        pool = openFundingPoolDeployer.deploy(postingId, posting.owner, token, auditRegistry);
        openFundingPoolForPosting[postingId] = pool;
        emit OpenFundingPoolCreated(postingId, pool, posting.owner, token);
    }

    function createEscrow(bytes32 proposalId, FundingTerms calldata terms) external returns (address escrow) {
        if (msg.sender != auditRegistry) revert AccessDenied();
        if (!allowedTokens[terms.token]) revert UnsupportedToken();
        TokenDecimals.requireUnchanged(terms.token, tokenDecimals[terms.token]);
        if (escrowForProposal[proposalId] != address(0)) revert ProposalAlreadyExists();
        AuditRegistry.Proposal memory proposal = AuditRegistry(auditRegistry).getProposal(proposalId);
        AuditRegistry.Opportunity memory posting = AuditRegistry(auditRegistry).getOpportunity(proposal.opportunityId);
        if (proposal.withdrawn || posting.withdrawn || posting.expiresAt <= block.timestamp) revert InvalidInput();
        if (posting.kind == AuditRegistry.OpportunityKind.OpenFunding) {
            address pool = openFundingPoolForPosting[proposal.opportunityId];
            if (pool == address(0) || IOpenFundingPool(pool).totalDeposited() == 0
                || IOpenFundingPool(pool).token() != terms.token || terms.funderVoting) revert InvalidInput();
        }
        EscrowInit memory init = EscrowInit(proposal.opportunityId, proposalId, terms.token, platformSigner,
            posting.owner, proposal.researcher, terms.target, posting.expiresAt, owner(), feeBps,
            address(this), auditRegistry, terms.funderVoting);
        escrow = escrowDeployer.deploy(init, terms);
        escrowForProposal[proposalId] = escrow;
        emit EscrowCreated(proposal.opportunityId, proposalId, escrow, posting.owner, terms.token, terms.target, posting.expiresAt, owner(), feeBps);
    }
}
