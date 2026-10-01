// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

struct FundingTerms {
    address token;
    uint256 target;
    bool funderVoting;
    uint16[] trancheBps;
    uint64[] reviewWindows;
    bytes32[] milestoneHashes;
}

struct EscrowInit {
    bytes32 postingId;
    bytes32 proposalId;
    address token;
    address platformSigner;
    address problemOwner;
    address proposalOwner;
    uint256 target;
    uint64 expiresAt;
    address feeRecipient;
    uint16 feeBps;
    address factory;
    address auditRegistry;
    bool funderVoting;
}

enum FundingEvent {
    EscrowCreated, Deposit, SelectionLocked, Approval, SelectionInvalidated,
    Cancelled, Expired, MilestoneSubmitted, TrancheReleased, Voided, RefundClaimed, FunderVote
}

interface IFundingFactory {
    function auditRegistry() external view returns (address);
    function platformSigner() external view returns (address);
    function allowedTokens(address token) external view returns (bool);
    function tokenDecimals(address token) external view returns (uint8);
    function isEscrowAdmin(address actor) external view returns (bool);
    function escrowForProposal(bytes32 proposalId) external view returns (address);
    function openFundingPoolForPosting(bytes32 postingId) external view returns (address);
    function createEscrow(bytes32 proposalId, FundingTerms calldata terms) external returns (address);
}

interface IEscrowAuditRegistry {
    function isFundingActive(bytes32 proposalId, address escrow) external view returns (bool);
    function isFundingInvalidated(bytes32 proposalId, address escrow) external view returns (bool);
    function recordFundingEvent(bytes32 proposalId, FundingEvent eventType, bytes32 digest, address actor) external;
    function recordOpenFundingDeposit(bytes32 postingId) external;
}

interface IFundedEscrow {
    function totalDeposited() external view returns (uint256);
    function token() external view returns (address);
    function fundingTarget() external view returns (uint256);
    function acceptOpenFunding() external;
    function voidOpenFunding() external;
}

interface IOpenFundingPool {
    function token() external view returns (address);
    function totalDeposited() external view returns (uint256);
    function offerState(bytes32 proposalId) external view returns (uint8);
}
