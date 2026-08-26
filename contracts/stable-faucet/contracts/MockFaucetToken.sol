// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockFaucetToken
/// @notice Six-decimal test token with owner-sponsored claims and an on-chain cooldown.
contract MockFaucetToken is ERC20, Ownable {
    uint8 private constant TOKEN_DECIMALS = 6;
    uint256 public constant CLAIM_AMOUNT = 10_000 * 10 ** TOKEN_DECIMALS;
    uint256 public constant COOLDOWN = 1 hours;
    uint256 public constant MAX_SUPPLY = 1_000_000_000 * 10 ** TOKEN_DECIMALS;

    mapping(address recipient => uint256 timestamp) public nextClaimAt;

    error InvalidRecipient();
    error CooldownActive(uint256 nextClaimAt);
    error MaxSupplyReached();

    constructor(
        string memory tokenName,
        string memory tokenSymbol,
        address initialOwner
    ) ERC20(tokenName, tokenSymbol) Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return TOKEN_DECIMALS;
    }

    function faucetMint(address recipient) external onlyOwner {
        if (recipient == address(0)) revert InvalidRecipient();

        uint256 availableAt = nextClaimAt[recipient];
        if (block.timestamp < availableAt) revert CooldownActive(availableAt);
        if (totalSupply() + CLAIM_AMOUNT > MAX_SUPPLY) revert MaxSupplyReached();

        nextClaimAt[recipient] = block.timestamp + COOLDOWN;
        _mint(recipient, CLAIM_AMOUNT);
    }
}
