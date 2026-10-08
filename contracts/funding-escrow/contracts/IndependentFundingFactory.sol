// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AuditRegistry} from "audit-registry/contracts/AuditRegistry.sol";
import {IndependentFundingEscrow} from "./IndependentFundingEscrow.sol";
import {IndependentEscrowInit, IIndependentTokenPolicy, IIndependentRegistryPolicy} from "./IndependentFundingTypes.sol";
import {TokenDecimals} from "./TokenDecimals.sol";

/// @notice Additive independent custody: no registry or existing factory rewiring.
contract IndependentFundingFactory is ReentrancyGuard {
    error AccessDenied();
    error InvalidInput();
    error UnsupportedToken();
    error EscrowAlreadyExists();
    address public immutable auditRegistry;
    IIndependentTokenPolicy public immutable tokenRegistry;
    address public immutable platformSigner;
    mapping(bytes32 => address) public escrowForListing;

    event EscrowCreated(bytes32 indexed listingId, address indexed escrow, address indexed researcher,
        address token, uint256 fundingTarget, uint64 expiresAt, uint32 reviewDays, bytes32 termsHash);

    constructor(address existingFundingFactory) {
        if (existingFundingFactory.code.length == 0) revert InvalidInput();
        tokenRegistry = IIndependentTokenPolicy(existingFundingFactory);
        address registry = tokenRegistry.auditRegistry();
        address platform = tokenRegistry.platformSigner();
        if (registry.code.length == 0 || platform == address(0)) revert InvalidInput();
        auditRegistry = registry;
        platformSigner = platform;
    }

    function createEscrow(bytes32 listingId, address token, uint256 target, uint32 reviewDays, bytes32 termsHash)
        external nonReentrant returns (address escrow)
    {
        AuditRegistry.Opportunity memory listing = AuditRegistry(auditRegistry).getOpportunity(listingId);
        if (listing.owner != msg.sender) revert AccessDenied();
        if (listing.kind != AuditRegistry.OpportunityKind.FundingRequest || listing.withdrawn
            || listing.expiresAt <= block.timestamp || target < 2 || reviewDays == 0 || reviewDays > 365
            || IIndependentRegistryPolicy(auditRegistry).postingFundingPaused(listingId)) revert InvalidInput();
        if (escrowForListing[listingId] != address(0)) revert EscrowAlreadyExists();
        if (!tokenRegistry.allowedTokens(token)) revert UnsupportedToken();
        uint8 decimals = tokenRegistry.tokenDecimals(token);
        TokenDecimals.requireUnchanged(token, decimals);
        if (termsHash != keccak256(abi.encode(listingId, listing.owner, token, target, listing.expiresAt, reviewDays))) revert InvalidInput();
        IndependentEscrowInit memory init;
        init.listingId = listingId;
        init.researcher = listing.owner;
        init.token = token;
        init.target = target;
        init.expiresAt = listing.expiresAt;
        init.reviewDays = reviewDays;
        init.termsHash = termsHash;
        init.listingContentHash = listing.contentHash;
        init.platformSigner = platformSigner;
        init.tokenRegistry = address(tokenRegistry);
        init.auditRegistry = auditRegistry;
        init.factory = address(this);
        init.feeRecipient = tokenRegistry.owner();
        init.feeBps = tokenRegistry.feeBps();
        init.tokenDecimals = decimals;
        escrow = address(new IndependentFundingEscrow(init));
        escrowForListing[listingId] = escrow;
        emit EscrowCreated(listingId, escrow, listing.owner, token, target, listing.expiresAt, reviewDays, termsHash);
    }
}
