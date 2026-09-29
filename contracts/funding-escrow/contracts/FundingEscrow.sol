// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TokenDecimals} from "./TokenDecimals.sol";
import {EscrowInit, FundingEvent, IFundingFactory, IEscrowAuditRegistry} from "./FundingTypes.sol";

/// @notice One registered proposal's pooled funding, milestone payments and refunds.
contract FundingEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State { Open, Locked, Released, Refunded, Cancelled, Expired, Active, Voided }
    enum DepositStatus { None, Locked, RefundPending, Refundable, Refunded, Released, PartiallyReleased }
    struct DepositorSummary {
        uint256 deposited;
        uint256 depositCount;
        uint256 refunded;
        uint256 claimable;
        uint256 released;
        DepositStatus status;
    }
    struct Milestone {
        uint16 bps;
        uint64 reviewWindow;
        bytes32 descriptionHash;
        uint256 grossAmount;
        bytes32 evidenceHash;
        uint256 fee;
        bool paid;
    }

    error AccessDenied();
    error InvalidInput();
    error InvalidState();
    error WindowClosed();
    error WindowStillOpen();
    error FundingTargetExceeded(uint256 remaining);
    error FundingIncomplete();
    error ApprovalIncomplete();
    error AlreadyApproved();
    error NothingToRefund();
    error UnsupportedTokenBehavior();
    error TokenNotListed();
    error InvalidPaymentPlan();
    error VotingDisabled();
    error AlreadyVoted();
    error FunderMajorityRequired();
    error WorkflowInactive();

    uint256 public constant APPROVAL_WINDOW = 7 days;
    uint256 public constant MAX_REVIEW_WINDOW = 365 days;
    uint256 public constant BPS_SCALE = 10_000;
    bytes32 public immutable postingId;
    bytes32 public immutable proposalId;
    IERC20 public immutable token;
    address public immutable platformSigner;
    address public immutable problemOwner;
    address public immutable proposalOwner;
    uint256 public immutable fundingTarget;
    uint64 public immutable expiresAt;
    address public immutable feeRecipient;
    uint16 public immutable feeBps;
    IFundingFactory public immutable tokenRegistry;
    IEscrowAuditRegistry public immutable auditRegistry;
    uint8 public immutable tokenDecimals;
    bool public immutable funderVoting;

    State public state;
    uint256 public totalDeposited;
    uint256 public totalRefunded;
    uint256 public totalReleased; // Gross, including feePaid.
    uint256 public feePaid;
    uint256 public totalDepositCount;
    bytes32 public selectionId;
    address public solutionOwner;
    uint64 public approvalDeadline;
    bool public ownerApproved;
    bool public solutionApproved;
    uint256 public currentTranche;
    uint256 public yesWeight;
    uint256 public noWeight;
    bool public refundsEnabled;
    uint64 public refundAvailableAt;
    uint256 public refundPool;

    mapping(address => uint256) public contributions;
    mapping(address => uint256) public depositCounts;
    mapping(address => uint256) public refundedAmounts;
    mapping(bytes32 => bool) public usedSelections;
    mapping(uint256 => mapping(bytes32 => bool)) private _usedEvidence;
    mapping(uint256 => mapping(bytes32 => mapping(address => bool))) public hasVoted;
    uint256 private _funderCount;
    mapping(address => uint256) private _funderIndex; // One-based, first-deposit order.
    mapping(uint256 => uint256) private _fundingTree;
    Milestone[] private _milestones;

    event StateChanged(State indexed previousState, State indexed newState);
    event Deposited(bytes32 indexed postingId, bytes32 indexed proposalId, address indexed depositor,
        address token, uint256 amount, uint256 cumulativeAmount, uint256 depositNumber);
    event SelectionLocked(bytes32 indexed selectionId, address indexed solutionOwner, uint64 approvalDeadline);
    event SelectionApproved(bytes32 indexed selectionId, address indexed approver);
    event MilestoneSubmitted(uint256 indexed index, bytes32 indexed evidenceHash);
    event MilestoneApproved(uint256 indexed index, bytes32 indexed evidenceHash, address indexed approver);
    event MilestoneVoted(uint256 indexed index, bytes32 indexed evidenceHash, address indexed voter, bool approve, uint256 weight);
    event TrancheReleased(uint256 indexed index, bytes32 indexed evidenceHash, uint256 grossAmount, uint256 fee, uint256 netAmount);
    event SelectionInvalidated(bytes32 indexed selectionId, bytes32 reasonHash);
    event Cancelled(bytes32 indexed reasonHash);
    event EscrowVoided(address indexed admin, bytes32 indexed reasonHash, uint256 refundPool);
    event Released(bytes32 indexed selectionId, address indexed solutionOwner, uint256 grossAmount, uint256 netAmount);
    event FeePaid(address indexed recipient, uint256 amount, uint16 feeBps);
    event RefundsOpened(uint256 pool, uint64 availableAt);
    event RefundClaimed(address indexed depositor, uint256 amount, uint256 cumulativeRefunded);

    modifier onlyPlatform() {
        if (msg.sender != platformSigner) revert AccessDenied();
        _;
    }

    constructor(EscrowInit memory init, uint16[] memory bps, uint64[] memory windows, bytes32[] memory descriptions) {
        if (init.postingId == bytes32(0) || init.proposalId == bytes32(0) || init.token.code.length == 0
            || init.platformSigner == address(0) || init.problemOwner == address(0) || init.proposalOwner == address(0)
            || init.problemOwner == init.proposalOwner || init.problemOwner == address(this) || init.proposalOwner == address(this)
            || init.target == 0 || init.expiresAt <= block.timestamp || init.feeRecipient == address(0)
            || init.feeRecipient == address(this) || init.feeBps > BPS_SCALE || init.factory.code.length == 0
            || init.auditRegistry.code.length == 0) revert InvalidInput();
        postingId = init.postingId;
        proposalId = init.proposalId;
        token = IERC20(init.token);
        platformSigner = init.platformSigner;
        problemOwner = init.problemOwner;
        proposalOwner = init.proposalOwner;
        fundingTarget = init.target;
        expiresAt = init.expiresAt;
        feeRecipient = init.feeRecipient;
        feeBps = init.feeBps;
        tokenRegistry = IFundingFactory(init.factory);
        auditRegistry = IEscrowAuditRegistry(init.auditRegistry);
        tokenDecimals = IFundingFactory(init.factory).tokenDecimals(init.token);
        funderVoting = init.funderVoting;
        _buildPlan(init.target, bps, windows, descriptions);
    }

    function _buildPlan(uint256 target, uint16[] memory bps, uint64[] memory windows, bytes32[] memory descriptions) private {
        if (bps.length == 0 || bps.length > 5 || windows.length != bps.length || descriptions.length != bps.length) revert InvalidPaymentPlan();
        uint256 cumulativeBps;
        uint256 allocated;
        for (uint256 i; i < bps.length; ++i) {
            cumulativeBps += bps[i];
            if (bps[i] == 0 || cumulativeBps > BPS_SCALE || windows[i] == 0 || windows[i] > MAX_REVIEW_WINDOW
                || descriptions[i] == bytes32(0)) revert InvalidPaymentPlan();
            uint256 cumulativeAmount = Math.mulDiv(target, cumulativeBps, BPS_SCALE);
            uint256 amount = cumulativeAmount - allocated;
            if (amount == 0) revert InvalidPaymentPlan();
            _milestones.push(Milestone(bps[i], windows[i], descriptions[i], amount, bytes32(0), 0, false));
            allocated = cumulativeAmount;
        }
        if (cumulativeBps != BPS_SCALE) revert InvalidPaymentPlan();
    }

    function deposit(uint256 amount) external nonReentrant {
        if (state != State.Open) revert InvalidState();
        if (block.timestamp >= expiresAt) revert WindowClosed();
        _requireWorkflowActive();
        if (!tokenRegistry.allowedTokens(address(token))) revert TokenNotListed();
        TokenDecimals.requireUnchanged(address(token), tokenDecimals);
        if (amount == 0) revert InvalidInput();
        uint256 remaining = fundingTarget - totalDeposited;
        if (amount > remaining) revert FundingTargetExceeded(remaining);
        _recordContribution(msg.sender, amount);
        contributions[msg.sender] += amount;
        depositCounts[msg.sender] += 1;
        totalDeposited += amount;
        totalDepositCount += 1;
        // Freeze registry editing before calling the token; rollback is atomic.
        _audit(FundingEvent.Deposit, keccak256(abi.encode(msg.sender, amount, contributions[msg.sender])));
        _transferInExact(msg.sender, amount);
        TokenDecimals.requireUnchanged(address(token), tokenDecimals);
        _requireWorkflowActive();
        emit Deposited(postingId, proposalId, msg.sender, address(token), amount, contributions[msg.sender], depositCounts[msg.sender]);
    }

    function lockSelection(bytes32 selectionId_, address solutionOwner_) external nonReentrant onlyPlatform {
        if (state != State.Open) revert InvalidState();
        if (block.timestamp >= expiresAt) revert WindowClosed();
        _requireWorkflowActive();
        if (totalDeposited != fundingTarget) revert FundingIncomplete();
        if (selectionId_ == bytes32(0) || usedSelections[selectionId_] || solutionOwner_ != proposalOwner) revert InvalidInput();
        selectionId = selectionId_;
        usedSelections[selectionId_] = true;
        solutionOwner = solutionOwner_;
        uint256 window = _milestones[0].reviewWindow;
        if (window > APPROVAL_WINDOW) window = APPROVAL_WINDOW;
        uint256 deadline = block.timestamp + window;
        approvalDeadline = deadline < expiresAt ? uint64(deadline) : expiresAt;
        _setState(State.Locked);
        _audit(FundingEvent.SelectionLocked, keccak256(abi.encode(selectionId_, solutionOwner_, approvalDeadline)));
        emit SelectionLocked(selectionId_, solutionOwner_, approvalDeadline);
    }

    /// @dev A growing Fenwick tree preserves cumulative wallet intervals without
    /// enumerating funders. Call before incrementing totalDeposited. Each node holds
    /// the sum in (index - lowbit(index), index]; top-ups update existing ancestors.
    function _recordContribution(address funder, uint256 amount) private {
        uint256 index = _funderIndex[funder];
        if (index == 0) {
            index = ++_funderCount;
            _funderIndex[funder] = index;
            uint256 start = index - (index & (~index + 1));
            // New nodes must include earlier wallets and all their prior top-ups.
            _fundingTree[index] = totalDeposited - _prefixSum(start) + amount;
        } else {
            uint256 count = _funderCount;
            while (true) {
                _fundingTree[index] += amount;
                uint256 step = index & (~index + 1);
                if (step > count - index) break; // Also avoids parent-index overflow.
                index += step;
            }
        }
    }

    function _prefixSum(uint256 index) private view returns (uint256 sum) {
        while (index != 0) {
            sum += _fundingTree[index];
            index -= index & (~index + 1);
        }
    }

    /// @notice Live cumulative funding in first-deposit order; fixed once fully funded.
    function fundingPrefixEnd(address funder) public view returns (uint256) {
        return _prefixSum(_funderIndex[funder]);
    }

    function approveSelection(bytes32 expectedSelectionId) external nonReentrant {
        if (currentTranche != 0) revert InvalidState();
        _requireCurrent(expectedSelectionId, 0, bytes32(0));
        _approve();
        _audit(FundingEvent.Approval, keccak256(abi.encode(expectedSelectionId, uint256(0), msg.sender)));
        emit SelectionApproved(expectedSelectionId, msg.sender);
    }

    function release(bytes32 expectedSelectionId) external nonReentrant onlyPlatform {
        if (currentTranche != 0) revert InvalidState();
        _release(expectedSelectionId, 0, bytes32(0));
    }

    /// @notice Later tranches require evidence and fresh approvals; edits reset votes too.
    function submitMilestone(uint256 index, bytes32 evidenceHash) external nonReentrant {
        if (msg.sender != proposalOwner) revert AccessDenied();
        if (state != State.Active || index != currentTranche) revert InvalidState();
        if (block.timestamp >= approvalDeadline) revert WindowClosed();
        _requireWorkflowActive();
        if (evidenceHash == bytes32(0) || _usedEvidence[index][evidenceHash]) revert InvalidInput();
        _usedEvidence[index][evidenceHash] = true;
        _milestones[index].evidenceHash = evidenceHash;
        ownerApproved = false;
        solutionApproved = false;
        yesWeight = 0;
        noWeight = 0;
        _audit(FundingEvent.MilestoneSubmitted, keccak256(abi.encode(index, evidenceHash)));
        emit MilestoneSubmitted(index, evidenceHash);
    }

    function approveMilestone(bytes32 expectedSelectionId, uint256 index, bytes32 evidenceHash) external nonReentrant {
        if (index == 0) revert InvalidState();
        _requireCurrent(expectedSelectionId, index, evidenceHash);
        _approve();
        _audit(FundingEvent.Approval, keccak256(abi.encode(expectedSelectionId, index, evidenceHash, msg.sender)));
        emit MilestoneApproved(index, evidenceHash, msg.sender);
    }

    function voteMilestone(uint256 index, bytes32 evidenceHash, bool approve) external nonReentrant {
        if (!funderVoting) revert VotingDisabled();
        if (index == 0) revert InvalidState();
        _requireCurrent(selectionId, index, evidenceHash);
        uint256 weight = contributions[msg.sender];
        if (weight == 0) revert AccessDenied();
        if (hasVoted[index][evidenceHash][msg.sender]) revert AlreadyVoted();
        hasVoted[index][evidenceHash][msg.sender] = true;
        if (approve) yesWeight += weight;
        else noWeight += weight;
        _audit(FundingEvent.FunderVote, keccak256(abi.encode(index, evidenceHash, msg.sender, approve, weight)));
        emit MilestoneVoted(index, evidenceHash, msg.sender, approve, weight);
    }

    function releaseMilestone(bytes32 expectedSelectionId, uint256 index, bytes32 evidenceHash) external nonReentrant onlyPlatform {
        if (index == 0) revert InvalidState();
        _release(expectedSelectionId, index, evidenceHash);
    }

    function _approve() private {
        if (msg.sender == problemOwner) {
            if (ownerApproved) revert AlreadyApproved();
            ownerApproved = true;
        } else if (msg.sender == proposalOwner) {
            if (solutionApproved) revert AlreadyApproved();
            solutionApproved = true;
        } else revert AccessDenied();
    }

    function _release(bytes32 expectedSelectionId, uint256 index, bytes32 evidenceHash) private {
        _requireCurrent(expectedSelectionId, index, evidenceHash);
        if (!ownerApproved || !solutionApproved) revert ApprovalIncomplete();
        if (index != 0 && funderVoting && yesWeight <= totalDeposited / 2) revert FunderMajorityRequired();
        Milestone storage milestone = _milestones[index];
        uint256 amount = milestone.grossAmount;
        uint256 cumulativeFee = Math.mulDiv(totalReleased + amount, feeBps, BPS_SCALE);
        uint256 fee = cumulativeFee - feePaid;
        totalReleased += amount;
        feePaid = cumulativeFee;
        milestone.fee = fee;
        milestone.paid = true;
        currentTranche += 1;
        ownerApproved = false;
        solutionApproved = false;
        yesWeight = 0;
        noWeight = 0;
        if (currentTranche == _milestones.length) {
            _setState(State.Released);
        } else {
            approvalDeadline = uint64(block.timestamp + _milestones[currentTranche].reviewWindow);
            _setState(State.Active);
        }
        if (amount > fee) _transferOutExact(proposalOwner, amount - fee);
        if (fee != 0) _transferOutExact(feeRecipient, fee);
        _requireWorkflowActive();
        _audit(FundingEvent.TrancheReleased, keccak256(abi.encode(index, evidenceHash, amount, fee)));
        emit FeePaid(feeRecipient, fee, feeBps);
        emit TrancheReleased(index, evidenceHash, amount, fee, amount - fee);
        if (state == State.Released) emit Released(expectedSelectionId, proposalOwner, totalReleased, totalReleased - feePaid);
    }

    function invalidateSelection(bytes32 expectedSelectionId, bytes32 reasonHash) external nonReentrant onlyPlatform {
        if (state != State.Locked || selectionId != expectedSelectionId) revert InvalidState();
        if (reasonHash == bytes32(0)) revert InvalidInput();
        selectionId = bytes32(0);
        solutionOwner = address(0);
        approvalDeadline = 0;
        ownerApproved = false;
        solutionApproved = false;
        if (block.timestamp >= expiresAt) _openRefunds(State.Expired, uint64(block.timestamp));
        else _setState(State.Open);
        _audit(FundingEvent.SelectionInvalidated, keccak256(abi.encode(expectedSelectionId, reasonHash)));
        emit SelectionInvalidated(expectedSelectionId, reasonHash);
    }

    /// @notice Ordinary cancellation before payment retains the posting lock window.
    function cancel(bytes32 reasonHash) external nonReentrant onlyPlatform {
        if (state != State.Open && state != State.Locked) revert InvalidState();
        if (reasonHash == bytes32(0)) revert InvalidInput();
        _openRefunds(State.Cancelled, expiresAt);
        _audit(FundingEvent.Cancelled, reasonHash);
        emit Cancelled(reasonHash);
    }

    /// @notice Moderation releases only the unpaid pool into immediate, fee-free refunds.
    function voidEscrow(bytes32 reasonHash) external nonReentrant {
        if (!tokenRegistry.isEscrowAdmin(msg.sender)) revert AccessDenied();
        if (state == State.Released || state == State.Refunded || state == State.Voided) revert InvalidState();
        if (reasonHash == bytes32(0)) revert InvalidInput();
        _openRefunds(State.Voided, uint64(block.timestamp));
        _audit(FundingEvent.Voided, reasonHash);
        emit EscrowVoided(msg.sender, reasonHash, refundPool);
    }

    /// @notice Anyone may synchronize a registry proposal/posting withdrawal into refunds.
    function refundInvalidated() external nonReentrant {
        if (state == State.Released || state == State.Refunded || state == State.Voided) revert InvalidState();
        if (auditRegistry.isFundingActive(proposalId, address(this))) revert InvalidState();
        _openRefunds(State.Voided, uint64(block.timestamp));
        _audit(FundingEvent.Voided, keccak256("REGISTRY_WITHDRAWAL"));
        emit EscrowVoided(msg.sender, keccak256("REGISTRY_WITHDRAWAL"), refundPool);
    }

    function expire() external nonReentrant { _expire(); }

    function _expire() private {
        if (state != State.Open && state != State.Locked && state != State.Active) revert InvalidState();
        uint256 deadline = state == State.Active ? approvalDeadline : expiresAt;
        if (block.timestamp < deadline) revert WindowStillOpen();
        _openRefunds(State.Expired, uint64(block.timestamp));
        _audit(FundingEvent.Expired, keccak256(abi.encode(currentTranche, deadline, refundPool)));
    }

    function _openRefunds(State next, uint64 availableAt) private {
        refundsEnabled = true;
        refundAvailableAt = availableAt;
        refundPool = totalDeposited - totalReleased;
        _setState(next);
        emit RefundsOpened(refundPool, availableAt);
    }

    function claimRefund() external nonReentrant {
        if (state == State.Released || state == State.Refunded) revert InvalidState();
        if (!refundsEnabled) _expire();
        if (block.timestamp < refundAvailableAt) revert WindowStillOpen();
        uint256 entitlement = _remainingShare(msg.sender, refundPool);
        uint256 amount = entitlement - refundedAmounts[msg.sender];
        if (amount == 0) revert NothingToRefund();
        refundedAmounts[msg.sender] += amount;
        totalRefunded += amount;
        if (totalRefunded == refundPool) _setState(State.Refunded);
        _transferOutExact(msg.sender, amount);
        _audit(FundingEvent.RefundClaimed, keccak256(abi.encode(msg.sender, amount)));
        emit RefundClaimed(msg.sender, amount, refundedAmounts[msg.sender]);
    }

    /// @dev Telescoping cumulative floors allocate every unit, independent of claim order.
    /// Each quota is within one base unit of its exact proportional share.
    function _remainingShare(address depositor, uint256 pool) private view returns (uint256) {
        uint256 contribution = contributions[depositor];
        if (contribution == 0) return 0;
        if (totalReleased == 0) return contribution;
        uint256 end = fundingPrefixEnd(depositor);
        return Math.mulDiv(pool, end, totalDeposited) - Math.mulDiv(pool, end - contribution, totalDeposited);
    }

    function depositorSummary(address depositor) external view returns (DepositorSummary memory summary) {
        summary.deposited = contributions[depositor];
        summary.depositCount = depositCounts[depositor];
        summary.refunded = refundedAmounts[depositor];
        if (summary.deposited == 0) return summary;
        uint256 unpaid = _remainingShare(depositor, totalDeposited - totalReleased);
        summary.released = summary.deposited - unpaid;
        if (unpaid == 0) { summary.status = DepositStatus.Released; return summary; }
        if (summary.refunded == unpaid) { summary.status = DepositStatus.Refunded; return summary; }
        bool eligible = refundsEnabled ? block.timestamp >= refundAvailableAt
            : block.timestamp >= (state == State.Active ? approvalDeadline : expiresAt);
        if (eligible) {
            summary.claimable = unpaid - summary.refunded;
            summary.status = DepositStatus.Refundable;
        } else if (refundsEnabled) summary.status = DepositStatus.RefundPending;
        else summary.status = totalReleased == 0 ? DepositStatus.Locked : DepositStatus.PartiallyReleased;
    }

    function outstandingBalance() external view returns (uint256) { return totalDeposited - totalRefunded - totalReleased; }
    function milestoneCount() external view returns (uint256) { return _milestones.length; }
    function milestoneAt(uint256 index) external view returns (Milestone memory) { return _milestones[index]; }
    function funderCount() external view returns (uint256) { return _funderCount; }

    function _requireCurrent(bytes32 expectedSelectionId, uint256 index, bytes32 evidenceHash) private view {
        if ((state != State.Locked && state != State.Active) || selectionId != expectedSelectionId || index != currentTranche) revert InvalidState();
        if (block.timestamp >= approvalDeadline) revert WindowClosed();
        if (index != 0 && (evidenceHash == bytes32(0) || _milestones[index].evidenceHash != evidenceHash)) revert InvalidInput();
        _requireWorkflowActive();
    }
    function _requireWorkflowActive() private view {
        if (!auditRegistry.isFundingActive(proposalId, address(this))) revert WorkflowInactive();
    }
    function _audit(FundingEvent eventType, bytes32 digest) private {
        auditRegistry.recordFundingEvent(proposalId, eventType, digest, msg.sender);
    }
    function _setState(State next) private {
        State previous = state;
        state = next;
        emit StateChanged(previous, next);
    }
    function _transferInExact(address sender, uint256 amount) private {
        uint256 senderBefore = token.balanceOf(sender);
        uint256 escrowBefore = token.balanceOf(address(this));
        token.safeTransferFrom(sender, address(this), amount);
        uint256 senderAfter = token.balanceOf(sender);
        uint256 escrowAfter = token.balanceOf(address(this));
        if (senderAfter > senderBefore || escrowAfter < escrowBefore
            || senderBefore - senderAfter != amount || escrowAfter - escrowBefore != amount) revert UnsupportedTokenBehavior();
    }
    function _transferOutExact(address recipient, uint256 amount) private {
        uint256 escrowBefore = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(recipient);
        token.safeTransfer(recipient, amount);
        uint256 escrowAfter = token.balanceOf(address(this));
        uint256 recipientAfter = token.balanceOf(recipient);
        if (escrowAfter > escrowBefore || recipientAfter < recipientBefore
            || escrowBefore - escrowAfter != amount || recipientAfter - recipientBefore != amount) revert UnsupportedTokenBehavior();
    }
}
