// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// We will use ERC20 which is heavily auditted by openzeppelin via inheritance
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title QFT
/// @notice Fixed-supply ERC-20 token. The entire supply is minted once at deployment.
contract QFT is ERC20 {
    error ZeroInitialSupply();

    constructor(
        address initialHolder,
        uint256 initialSupply
    ) ERC20("QFT", "QFT") {
        if (initialSupply == 0) revert ZeroInitialSupply();

        _mint(initialHolder, initialSupply);
    }
}
