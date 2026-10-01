// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OpenFundingPool} from "./OpenFundingPool.sol";

/// @dev Only the canonical factory may create its grant custody pools.
contract OpenFundingPoolDeployer {
    address public immutable factory;
    error AccessDenied();

    constructor(address factory_) { factory = factory_; }

    function deploy(bytes32 postingId, address owner, address token, address registry) external returns (address) {
        if (msg.sender != factory) revert AccessDenied();
        return address(new OpenFundingPool(postingId, owner, token, factory, registry));
    }
}
