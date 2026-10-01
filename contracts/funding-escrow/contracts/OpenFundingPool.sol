// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AuditRegistry} from "audit-registry/contracts/AuditRegistry.sol";
import {TokenDecimals} from "./TokenDecimals.sol";
import {IFundingFactory, IFundedEscrow, IEscrowAuditRegistry} from "./FundingTypes.sol";

/// @notice A single owner's prefunded grant opportunity, separate from pooled funding.
contract OpenFundingPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum OfferState { None, Pending, Accepted, Voided }
    struct Offer { uint256 amount; uint64 acceptanceDeadline; OfferState state; }
    error AccessDenied();
    error InvalidInput();
    error InvalidState();
    error InsufficientAvailableFunding(uint256 available);
    error WindowClosed();
    error WindowStillOpen();
    error UnsupportedTokenBehavior();
    error TokenNotListed();

    uint256 public constant ACCEPTANCE_WINDOW = 7 days;
    bytes32 public immutable postingId;
    address public immutable owner;
    IERC20 public immutable token;
    uint8 public immutable tokenDecimals;
    IFundingFactory public immutable factory;
    AuditRegistry public immutable registry;
    uint256 public totalDeposited;
    uint256 public totalAllocated;
    uint256 public totalWithdrawn;
    uint256 public reservedAmount;
    mapping(bytes32 => Offer) private _offers;
    bytes32[] private _proposals;

    event Deposited(bytes32 indexed postingId, address indexed owner, uint256 amount, uint256 totalDeposited);
    event ProposalSelected(bytes32 indexed proposalId, address indexed researcher, address indexed escrow,
        uint256 amount, uint64 acceptanceDeadline);
    event ProposalAccepted(bytes32 indexed proposalId, address indexed researcher, address indexed escrow, uint256 amount);
    event ProposalVoided(bytes32 indexed proposalId, uint256 amount);
    event AvailableWithdrawn(address indexed owner, uint256 amount);

    constructor(bytes32 postingId_, address owner_, address token_, address factory_, address registry_) {
        postingId = postingId_;
        owner = owner_;
        token = IERC20(token_);
        factory = IFundingFactory(factory_);
        registry = AuditRegistry(registry_);
        tokenDecimals = IFundingFactory(factory_).tokenDecimals(token_);
    }

    modifier onlyOwner() { if (msg.sender != owner) revert AccessDenied(); _; }

    function availableBalance() public view returns (uint256) {
        return totalDeposited - totalAllocated - totalWithdrawn - reservedAmount;
    }
    function auditRegistry() external view returns (address) { return address(registry); }
    function getOffer(bytes32 proposalId) external view returns (Offer memory) { return _offers[proposalId]; }
    function offerState(bytes32 proposalId) external view returns (uint8) { return uint8(_offers[proposalId].state); }
    function proposalCount() external view returns (uint256) { return _proposals.length; }
    function proposalAt(uint256 index) external view returns (bytes32) { return _proposals[index]; }

    /// @notice The owner may increase custody after any awards, including after submission closes.
    function deposit(uint256 amount) external nonReentrant onlyOwner {
        if (amount == 0) revert InvalidInput();
        if (registry.getOpportunity(postingId).withdrawn) revert InvalidState();
        _requireTokenListed();
        uint256 ownerBefore = token.balanceOf(owner);
        uint256 poolBefore = token.balanceOf(address(this));
        totalDeposited += amount;
        IEscrowAuditRegistry(address(registry)).recordOpenFundingDeposit(postingId);
        token.safeTransferFrom(owner, address(this), amount);
        _requireExactMovement(ownerBefore, token.balanceOf(owner), poolBefore, token.balanceOf(address(this)), amount);
        TokenDecimals.requireUnchanged(address(token), tokenDecimals);
        emit Deposited(postingId, owner, amount, totalDeposited);
    }

    function selectProposal(bytes32 proposalId) external nonReentrant onlyOwner {
        AuditRegistry.Opportunity memory posting = registry.getOpportunity(postingId);
        if (posting.withdrawn || block.timestamp >= posting.expiresAt) revert WindowClosed();
        if (_offers[proposalId].state != OfferState.None) revert InvalidState();
        AuditRegistry.Proposal memory proposal = registry.getProposal(proposalId);
        address escrow = factory.escrowForProposal(proposalId);
        if (proposal.opportunityId != postingId || proposal.withdrawn || escrow == address(0)
            || !IEscrowAuditRegistry(address(registry)).isFundingActive(proposalId, escrow)) revert InvalidState();
        _requireTokenListed();
        uint256 amount = IFundedEscrow(escrow).fundingTarget();
        uint256 available = availableBalance();
        if (amount > available) revert InsufficientAvailableFunding(available);
        uint64 deadline = uint64(block.timestamp + ACCEPTANCE_WINDOW);
        _offers[proposalId] = Offer(amount, deadline, OfferState.Pending);
        _proposals.push(proposalId);
        reservedAmount += amount;
        emit ProposalSelected(proposalId, proposal.researcher, escrow, amount, deadline);
    }

    /// @notice Acceptance atomically moves only this offer into its canonical proposal escrow.
    function acceptProposal(bytes32 proposalId) external nonReentrant {
        Offer storage offer = _offers[proposalId];
        AuditRegistry.Proposal memory proposal = registry.getProposal(proposalId);
        if (msg.sender != proposal.researcher) revert AccessDenied();
        if (offer.state != OfferState.Pending) revert InvalidState();
        if (block.timestamp >= offer.acceptanceDeadline) revert WindowClosed();
        address escrow = factory.escrowForProposal(proposalId);
        if (!IEscrowAuditRegistry(address(registry)).isFundingActive(proposalId, escrow)) revert InvalidState();
        _requireTokenListed();
        offer.state = OfferState.Accepted;
        reservedAmount -= offer.amount;
        totalAllocated += offer.amount;
        token.forceApprove(escrow, offer.amount);
        IFundedEscrow(escrow).acceptOpenFunding();
        token.forceApprove(escrow, 0);
        TokenDecimals.requireUnchanged(address(token), tokenDecimals);
        emit ProposalAccepted(proposalId, proposal.researcher, escrow, offer.amount);
    }

    /// @notice Permissionless synchronization releases reservations at the exact deadline.
    function expireProposal(bytes32 proposalId) external nonReentrant {
        Offer storage offer = _offers[proposalId];
        if (offer.state != OfferState.Pending) revert InvalidState();
        address escrow = factory.escrowForProposal(proposalId);
        if (block.timestamp < offer.acceptanceDeadline
            && !IEscrowAuditRegistry(address(registry)).isFundingInvalidated(proposalId, escrow)) revert WindowStillOpen();
        offer.state = OfferState.Voided;
        reservedAmount -= offer.amount;
        IFundedEscrow(escrow).voidOpenFunding();
        emit ProposalVoided(proposalId, offer.amount);
    }

    /// @notice Closing the posting permits retrieval of unallocated funds; pending grants stay reserved.
    function withdrawAvailable(uint256 amount) external nonReentrant onlyOwner {
        AuditRegistry.Opportunity memory posting = registry.getOpportunity(postingId);
        if (!posting.withdrawn && block.timestamp < posting.expiresAt) revert WindowStillOpen();
        if (amount == 0) revert InvalidInput();
        uint256 available = availableBalance();
        if (amount > available) revert InsufficientAvailableFunding(available);
        uint256 poolBefore = token.balanceOf(address(this));
        uint256 ownerBefore = token.balanceOf(owner);
        totalWithdrawn += amount;
        token.safeTransfer(owner, amount);
        _requireExactMovement(poolBefore, token.balanceOf(address(this)), ownerBefore, token.balanceOf(owner), amount);
        emit AvailableWithdrawn(owner, amount);
    }

    function _requireTokenListed() private view {
        if (!factory.allowedTokens(address(token))) revert TokenNotListed();
        TokenDecimals.requireUnchanged(address(token), tokenDecimals);
    }
    function _requireExactMovement(uint256 fromBefore, uint256 fromAfter, uint256 toBefore, uint256 toAfter, uint256 amount) private pure {
        if (fromAfter > fromBefore || toAfter < toBefore || fromBefore - fromAfter != amount || toAfter - toBefore != amount)
            revert UnsupportedTokenBehavior();
    }
}
