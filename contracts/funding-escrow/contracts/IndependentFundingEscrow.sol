// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AuditRegistry} from "audit-registry/contracts/AuditRegistry.sol";
import {FundingAmountPolicy} from "./FundingAmountPolicy.sol";
import {TokenDecimals} from "./TokenDecimals.sol";
import {IndependentEscrowInit, IIndependentTokenPolicy, IIndependentRegistryPolicy} from "./IndependentFundingTypes.sol";

/// @notice Independent crowdfunding, isolated from proposal selection and grant pools.
contract IndependentFundingEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum State { Open, Accepted, Released, Declined, Expired, Cancelled, Refunded }
    struct Snapshot {
        State state;
        bytes32 listingId;
        address researcher;
        address token;
        uint8 tokenDecimals;
        uint256 fundingTarget;
        uint64 expiresAt;
        uint32 reviewDays;
        uint64 completionDeadline;
        bytes32 termsHash;
        bytes32 listingContentHash;
        address platformSigner;
        address tokenRegistry;
        address auditRegistry;
        address factory;
        uint16 feeBps;
        address feeRecipient;
        uint256 totalDeposited;
        uint256 totalReleased;
        uint256 totalRefunded;
        uint256 feePaid;
        uint256 outstandingBalance;
        uint256 refundPool;
        bool refundsEnabled;
        bytes32 evidenceHash;
        uint256 evidenceVersion;
        uint256 yesWeight;
        uint256 noWeight;
        uint256 funderCount;
        uint256 contribution;
        uint256 refunded;
        uint256 claimable;
        bool hasVoted;
        bool votedApprove;
        bool active;
        bool depositsOpen;
        bool canAccept;
        bool canDecline;
        bool canSubmitEvidence;
        bool canVote;
        bool canReleaseCompletion;
    }
    struct DepositorSummary { uint256 deposited; uint256 refunded; uint256 claimable; uint256 released; }

    error AccessDenied();
    error InvalidInput();
    error InvalidState();
    error WindowClosed();
    error WindowStillOpen();
    error FundingIncomplete();
    error FundingTargetExceeded(uint256 remaining);
    error NothingToRefund();
    error AlreadyVoted();
    error FunderMajorityRequired();
    error WorkflowInactive();
    error TokenNotListed();
    error UnsupportedTokenBehavior();

    uint256 public constant BPS_SCALE = 10_000;
    bytes32 public immutable listingId;
    address public immutable researcher;
    IERC20 public immutable token;
    uint8 public immutable tokenDecimals;
    uint256 public immutable fundingTarget;
    uint64 public immutable expiresAt;
    uint32 public immutable reviewDays;
    bytes32 public immutable termsHash;
    bytes32 public immutable listingContentHash;
    address public immutable platformSigner;
    IIndependentTokenPolicy public immutable tokenRegistry;
    address public immutable auditRegistry;
    address public immutable factory;
    uint16 public immutable feeBps;
    address public immutable feeRecipient;
    State public state;
    uint64 public completionDeadline;
    uint256 public totalDeposited;
    uint256 public totalReleased; // Gross, including the cumulative feePaid.
    uint256 public totalRefunded;
    uint256 public feePaid;
    uint256 public refundPool;
    bool public refundsEnabled;
    bytes32 public evidenceHash;
    uint256 public evidenceVersion;
    uint256 public yesWeight;
    uint256 public noWeight;
    uint256 public funderCount;
    mapping(address => uint256) public contributions;
    mapping(address => uint256) public refundedAmounts;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    mapping(uint256 => mapping(address => bool)) public votedApprove;
    mapping(bytes32 => bool) private _usedEvidence;
    mapping(address => uint256) private _funderIndex;
    mapping(uint256 => uint256) private _fundingTree;

    event StateChanged(uint8 previousState, uint8 newState);
    event Deposited(address indexed funder, uint256 amount, uint256 totalDeposited, uint256 contribution);
    event FundingAccepted(uint64 completionDeadline, uint256 upfrontGross);
    event FundingDeclined(bytes32 indexed reasonHash);
    event EvidenceSubmitted(uint256 indexed evidenceVersion, bytes32 indexed evidenceHash);
    event CompletionVoted(uint256 indexed evidenceVersion, bytes32 indexed evidenceHash, address indexed funder, bool approve, uint256 weight);
    event TrancheReleased(uint8 indexed index, uint256 grossAmount, uint256 fee, uint256 netAmount);
    event Cancelled(address indexed actor, bytes32 indexed reasonHash);
    event RefundsOpened(uint8 state, uint256 pool);
    event RefundClaimed(address indexed funder, uint256 amount, uint256 cumulativeRefunded);

    constructor(IndependentEscrowInit memory init) {
        if (msg.sender != init.factory) revert AccessDenied();
        if (init.listingId == bytes32(0) || init.researcher == address(0) || init.token.code.length == 0
            || init.target < 2 || init.expiresAt <= block.timestamp || init.reviewDays == 0 || init.reviewDays > 365
            || init.termsHash == bytes32(0) || init.listingContentHash == bytes32(0) || init.platformSigner == address(0)
            || init.tokenRegistry.code.length == 0 || init.auditRegistry.code.length == 0 || init.factory.code.length == 0
            || init.feeRecipient == address(0) || init.feeRecipient == address(this) || init.feeBps > BPS_SCALE) revert InvalidInput();
        listingId = init.listingId;
        researcher = init.researcher;
        token = IERC20(init.token);
        tokenDecimals = init.tokenDecimals;
        FundingAmountPolicy.requirePrecision(init.target, tokenDecimals);
        fundingTarget = init.target;
        expiresAt = init.expiresAt;
        reviewDays = init.reviewDays;
        termsHash = init.termsHash;
        listingContentHash = init.listingContentHash;
        platformSigner = init.platformSigner;
        tokenRegistry = IIndependentTokenPolicy(init.tokenRegistry);
        auditRegistry = init.auditRegistry;
        factory = init.factory;
        feeBps = init.feeBps;
        feeRecipient = init.feeRecipient;
    }

    function deposit(uint256 amount) external nonReentrant {
        if (msg.sender == researcher) revert AccessDenied();
        if (state != State.Open) revert InvalidState();
        if (block.timestamp >= expiresAt) revert WindowClosed();
        _requireActive();
        if (!tokenRegistry.allowedTokens(address(token))) revert TokenNotListed();
        TokenDecimals.requireUnchanged(address(token), tokenDecimals);
        if (amount == 0) revert InvalidInput();
        uint256 remaining = fundingTarget - totalDeposited;
        if (amount > remaining) revert FundingTargetExceeded(remaining);
        FundingAmountPolicy.requireContribution(amount, remaining, tokenDecimals);
        _recordContribution(msg.sender, amount);
        contributions[msg.sender] += amount;
        totalDeposited += amount;
        _transferInExact(msg.sender, amount);
        TokenDecimals.requireUnchanged(address(token), tokenDecimals);
        _requireActive();
        emit Deposited(msg.sender, amount, totalDeposited, contributions[msg.sender]);
    }

    function acceptFunding() external nonReentrant {
        _requireResearcherDecision();
        _requireActive();
        if (!tokenRegistry.allowedTokens(address(token))) revert TokenNotListed();
        TokenDecimals.requireUnchanged(address(token), tokenDecimals);
        completionDeadline = uint64(block.timestamp + uint256(reviewDays) * 1 days);
        _setState(State.Accepted);
        uint256 upfront = fundingTarget / 2;
        _pay(0, upfront);
        _requireActive();
        emit FundingAccepted(completionDeadline, upfront);
    }

    function declineFunding(bytes32 reasonHash) external nonReentrant {
        _requireResearcherDecision();
        if (reasonHash == bytes32(0)) revert InvalidInput();
        _openRefunds(State.Declined);
        emit FundingDeclined(reasonHash);
    }

    function submitEvidence(bytes32 hash) external nonReentrant {
        if (msg.sender != researcher) revert AccessDenied();
        _requireCompletionOpen();
        if (hash == bytes32(0) || _usedEvidence[hash]) revert InvalidInput();
        _usedEvidence[hash] = true;
        evidenceHash = hash;
        evidenceVersion++;
        yesWeight = 0;
        noWeight = 0;
        emit EvidenceSubmitted(evidenceVersion, hash);
    }

    function voteCompletion(uint256 version, bytes32 hash, bool approve) external nonReentrant {
        _requireCompletionOpen();
        if (version != evidenceVersion || hash == bytes32(0) || hash != evidenceHash) revert InvalidInput();
        uint256 weight = contributions[msg.sender];
        if (weight == 0) revert AccessDenied();
        if (hasVoted[version][msg.sender]) revert AlreadyVoted();
        hasVoted[version][msg.sender] = true;
        votedApprove[version][msg.sender] = approve;
        if (approve) yesWeight += weight;
        else noWeight += weight;
        emit CompletionVoted(version, hash, msg.sender, approve, weight);
        if (yesWeight > totalDeposited / 2) _releaseCompletion();
    }

    function releaseCompletion() external nonReentrant { _releaseCompletion(); }

    function adminCancel(bytes32 reasonHash) external nonReentrant {
        if (msg.sender != platformSigner && !tokenRegistry.isEscrowAdmin(msg.sender)) revert AccessDenied();
        if (state != State.Open && state != State.Accepted) revert InvalidState();
        if (reasonHash == bytes32(0)) revert InvalidInput();
        _openRefunds(State.Cancelled);
        emit Cancelled(msg.sender, reasonHash);
    }

    function expire() external nonReentrant {
        if (state != State.Open && state != State.Accepted) revert InvalidState();
        if (!_invalidated() && !_timedOut()) revert WindowStillOpen();
        _openRefunds(_invalidated() ? State.Cancelled : State.Expired);
    }

    function claimRefund() external nonReentrant {
        if (!refundsEnabled) {
            if (state != State.Open && state != State.Accepted) revert InvalidState();
            if (!_invalidated() && !_timedOut()) revert WindowStillOpen();
            _openRefunds(_invalidated() ? State.Cancelled : State.Expired);
        }
        uint256 amount = _remainingShare(msg.sender, refundPool) - refundedAmounts[msg.sender];
        if (amount == 0) revert NothingToRefund();
        refundedAmounts[msg.sender] += amount;
        totalRefunded += amount;
        if (totalRefunded == refundPool) _setState(State.Refunded);
        _transferOutExact(msg.sender, amount);
        emit RefundClaimed(msg.sender, amount, refundedAmounts[msg.sender]);
    }

    function outstandingBalance() public view returns (uint256) { return totalDeposited - totalReleased - totalRefunded; }

    function getState(address account) external view returns (Snapshot memory result) {
        bool invalidated = (state == State.Open || state == State.Accepted) && _invalidated();
        bool timedOut = (state == State.Open || state == State.Accepted) && _timedOut();
        bool refundable = refundsEnabled || invalidated || timedOut;
        bool active = !invalidated && !IIndependentRegistryPolicy(auditRegistry).postingFundingPaused(listingId);
        State effective = invalidated ? State.Cancelled : timedOut ? State.Expired : state;
        result.state = effective;
        result.listingId = listingId;
        result.researcher = researcher;
        result.token = address(token);
        result.tokenDecimals = tokenDecimals;
        result.fundingTarget = fundingTarget;
        result.expiresAt = expiresAt;
        result.reviewDays = reviewDays;
        result.completionDeadline = completionDeadline;
        result.termsHash = termsHash;
        result.listingContentHash = listingContentHash;
        result.platformSigner = platformSigner;
        result.tokenRegistry = address(tokenRegistry);
        result.auditRegistry = auditRegistry;
        result.factory = factory;
        result.feeBps = feeBps;
        result.feeRecipient = feeRecipient;
        result.totalDeposited = totalDeposited;
        result.totalReleased = totalReleased;
        result.totalRefunded = totalRefunded;
        result.feePaid = feePaid;
        result.outstandingBalance = outstandingBalance();
        result.refundPool = refundable && !refundsEnabled ? totalDeposited - totalReleased : refundPool;
        result.refundsEnabled = refundable;
        result.evidenceHash = evidenceHash;
        result.evidenceVersion = evidenceVersion;
        result.yesWeight = yesWeight;
        result.noWeight = noWeight;
        result.funderCount = funderCount;
        result.contribution = contributions[account];
        result.refunded = refundedAmounts[account];
        result.claimable = refundable ? _remainingShare(account, totalDeposited - totalReleased) - refundedAmounts[account] : 0;
        result.hasVoted = hasVoted[evidenceVersion][account];
        result.votedApprove = votedApprove[evidenceVersion][account];
        result.active = active;
        result.depositsOpen = effective == State.Open && active && totalDeposited < fundingTarget && tokenRegistry.allowedTokens(address(token));
        result.canAccept = effective == State.Open && active && account == researcher && totalDeposited == fundingTarget && tokenRegistry.allowedTokens(address(token));
        result.canDecline = effective == State.Open && account == researcher && totalDeposited == fundingTarget;
        result.canSubmitEvidence = effective == State.Accepted && active && account == researcher;
        result.canVote = effective == State.Accepted && active && evidenceHash != bytes32(0) && result.contribution != 0 && !result.hasVoted;
        result.canReleaseCompletion = effective == State.Accepted && active && evidenceHash != bytes32(0) && yesWeight > totalDeposited / 2;
    }

    function depositorSummary(address account) external view returns (DepositorSummary memory result) {
        result.deposited = contributions[account];
        result.refunded = refundedAmounts[account];
        uint256 unpaid = _remainingShare(account, totalDeposited - totalReleased);
        result.released = result.deposited - unpaid;
        if (refundsEnabled || ((state == State.Open || state == State.Accepted) && (_timedOut() || _invalidated()))) {
            result.claimable = unpaid - result.refunded;
        }
    }

    function _requireResearcherDecision() private view {
        if (msg.sender != researcher) revert AccessDenied();
        if (state != State.Open) revert InvalidState();
        if (block.timestamp >= expiresAt) revert WindowClosed();
        if (totalDeposited != fundingTarget) revert FundingIncomplete();
    }
    function _requireCompletionOpen() private view {
        if (state != State.Accepted) revert InvalidState();
        if (block.timestamp >= completionDeadline) revert WindowClosed();
        _requireActive();
    }
    function _releaseCompletion() private {
        _requireCompletionOpen();
        if (evidenceHash == bytes32(0) || yesWeight <= totalDeposited / 2) revert FunderMajorityRequired();
        _setState(State.Released);
        _pay(1, fundingTarget - totalReleased);
        _requireActive();
    }
    function _pay(uint8 index, uint256 gross) private {
        uint256 cumulativeFee = Math.mulDiv(totalReleased + gross, feeBps, BPS_SCALE);
        uint256 fee = cumulativeFee - feePaid;
        totalReleased += gross;
        feePaid = cumulativeFee;
        if (gross > fee) _transferOutExact(researcher, gross - fee);
        if (fee != 0) _transferOutExact(feeRecipient, fee);
        emit TrancheReleased(index, gross, fee, gross - fee);
    }
    function _timedOut() private view returns (bool) {
        return block.timestamp >= (state == State.Accepted ? completionDeadline : expiresAt);
    }
    function _invalidated() private view returns (bool) {
        AuditRegistry.Opportunity memory listing = AuditRegistry(auditRegistry).getOpportunity(listingId);
        return listing.withdrawn || listing.owner != researcher || listing.kind != AuditRegistry.OpportunityKind.FundingRequest
            || listing.contentHash != listingContentHash || listing.expiresAt != expiresAt;
    }
    function _requireActive() private view {
        if (_invalidated() || IIndependentRegistryPolicy(auditRegistry).postingFundingPaused(listingId)) revert WorkflowInactive();
    }
    function _openRefunds(State next) private {
        refundsEnabled = true;
        refundPool = totalDeposited - totalReleased;
        _setState(next);
        emit RefundsOpened(uint8(next), refundPool);
    }
    function _setState(State next) private {
        State previous = state;
        state = next;
        emit StateChanged(uint8(previous), uint8(next));
    }
    // Same telescoping, top-up-safe allocation used by the existing escrow.
    function _recordContribution(address funder, uint256 amount) private {
        uint256 index = _funderIndex[funder];
        if (index == 0) {
            index = ++funderCount;
            _funderIndex[funder] = index;
            uint256 start = index - (index & (~index + 1));
            _fundingTree[index] = totalDeposited - _prefixSum(start) + amount;
        } else {
            while (true) {
                _fundingTree[index] += amount;
                uint256 step = index & (~index + 1);
                if (step > funderCount - index) break;
                index += step;
            }
        }
    }
    function _prefixSum(uint256 index) private view returns (uint256 sum) {
        while (index != 0) { sum += _fundingTree[index]; index -= index & (~index + 1); }
    }
    function _remainingShare(address account, uint256 pool) private view returns (uint256) {
        uint256 contribution = contributions[account];
        if (contribution == 0) return 0;
        if (totalReleased == 0) return contribution;
        uint256 end = _prefixSum(_funderIndex[account]);
        return Math.mulDiv(pool, end, totalDeposited) - Math.mulDiv(pool, end - contribution, totalDeposited);
    }
    function _transferInExact(address sender, uint256 amount) private {
        uint256 senderBefore = token.balanceOf(sender);
        uint256 escrowBefore = token.balanceOf(address(this));
        token.safeTransferFrom(sender, address(this), amount);
        uint256 senderAfter = token.balanceOf(sender);
        uint256 escrowAfter = token.balanceOf(address(this));
        if (senderAfter > senderBefore || escrowAfter < escrowBefore || senderBefore - senderAfter != amount
            || escrowAfter - escrowBefore != amount) revert UnsupportedTokenBehavior();
    }
    function _transferOutExact(address recipient, uint256 amount) private {
        uint256 escrowBefore = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(recipient);
        token.safeTransfer(recipient, amount);
        uint256 escrowAfter = token.balanceOf(address(this));
        uint256 recipientAfter = token.balanceOf(recipient);
        if (escrowAfter > escrowBefore || recipientAfter < recipientBefore || escrowBefore - escrowAfter != amount
            || recipientAfter - recipientBefore != amount) revert UnsupportedTokenBehavior();
    }
}
