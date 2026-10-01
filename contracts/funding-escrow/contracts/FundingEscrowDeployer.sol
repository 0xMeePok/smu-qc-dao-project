// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FundingEscrow} from "./FundingEscrow.sol";
import {EscrowInit, FundingTerms} from "./FundingTypes.sol";

/// @dev Keeps escrow creation bytecode outside the canonical factory's runtime.
contract FundingEscrowDeployer {
    address public immutable factory;
    error AccessDenied();

    constructor(address factory_) { factory = factory_; }

    function deploy(EscrowInit calldata init, FundingTerms calldata terms) external returns (address) {
        if (msg.sender != factory || init.factory != factory) revert AccessDenied();
        return address(new FundingEscrow(init, terms.trancheBps, terms.reviewWindows, terms.milestoneHashes));
    }
}
