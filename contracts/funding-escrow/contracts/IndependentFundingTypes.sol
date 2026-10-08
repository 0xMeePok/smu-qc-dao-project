// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IIndependentTokenPolicy {
    function auditRegistry() external view returns (address);
    function platformSigner() external view returns (address);
    function owner() external view returns (address);
    function feeBps() external view returns (uint16);
    function allowedTokens(address token) external view returns (bool);
    function tokenDecimals(address token) external view returns (uint8);
    function isEscrowAdmin(address actor) external view returns (bool);
}

interface IIndependentRegistryPolicy {
    function postingFundingPaused(bytes32 listingId) external view returns (bool);
}

struct IndependentEscrowInit {
    bytes32 listingId;
    address researcher;
    address token;
    uint256 target;
    uint64 expiresAt;
    uint32 reviewDays;
    bytes32 termsHash;
    bytes32 listingContentHash;
    address platformSigner;
    address tokenRegistry;
    address auditRegistry;
    address factory;
    address feeRecipient;
    uint16 feeBps;
    uint8 tokenDecimals;
}
