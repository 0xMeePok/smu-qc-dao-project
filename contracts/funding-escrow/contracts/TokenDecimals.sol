// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @dev Listing policy: one whole token's scale must fit in uint256 (10**77 does).
library TokenDecimals {
    uint8 internal constant MAX_DECIMALS = 77;

    error InvalidTokenDecimals();
    error UnsupportedTokenDecimals(uint256 decimals);
    error TokenDecimalsChanged(uint8 expected, uint8 actual);

    function read(address token) internal view returns (uint8) {
        (bool success, bytes memory result) = token.staticcall(abi.encodeCall(IERC20Metadata.decimals, ()));
        if (!success || result.length != 32) revert InvalidTokenDecimals();
        uint256 value = abi.decode(result, (uint256));
        if (value > MAX_DECIMALS) revert UnsupportedTokenDecimals(value);
        return uint8(value);
    }

    function requireUnchanged(address token, uint8 expected) internal view {
        uint8 actual = read(token);
        if (actual != expected) revert TokenDecimalsChanged(expected, actual);
    }
}
