// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Applies only to proposal targets and direct contributions. Payment,
/// fee, refund and grant-pool accounting retain their exact base-unit amounts.
library FundingAmountPolicy {
    error AmountPrecisionExceeded(uint8 maximumDecimals);
    error ContributionBelowMinimum(uint256 minimum);
    error ContributionLeavesDust(uint256 remainingAfter, uint256 minimum);

    function requirePrecision(uint256 amount, uint8 decimals) internal pure {
        uint8 maximumDecimals = decimals < 2 ? decimals : 2;
        uint256 increment = 10 ** uint256(decimals - maximumDecimals);
        if (amount % increment != 0) revert AmountPrecisionExceeded(maximumDecimals);
    }

    // Caller first checks 0 < amount <= remaining.
    function requireContribution(uint256 amount, uint256 remaining, uint8 decimals) internal pure {
        requirePrecision(amount, decimals);
        if (amount == remaining) return;
        uint256 minimum = 10 ** uint256(decimals);
        if (amount < minimum) revert ContributionBelowMinimum(minimum);
        uint256 remainingAfter = remaining - amount;
        if (remainingAfter < minimum) revert ContributionLeavesDust(remainingAfter, minimum);
    }
}
