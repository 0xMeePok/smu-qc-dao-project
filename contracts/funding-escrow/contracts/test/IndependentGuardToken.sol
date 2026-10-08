// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IndependentFundingEscrow} from "../IndependentFundingEscrow.sol";

/// @dev Local callback regression fixture; never configure as a deployed token.
contract IndependentGuardToken is ERC20 {
    uint8 private immutable _precision;
    bool public probe;
    uint256 public guardedCallbacks;
    error GuardNotEnforced();
    constructor(uint8 precision) ERC20("Independent guard test", "IGT") { _precision = precision; }
    function decimals() public view override returns (uint8) { return _precision; }
    function mint(address account, uint256 amount) external { _mint(account, amount); }
    function setProbe(bool enabled) external { probe = enabled; }
    function transfer(address recipient, uint256 amount) public override returns (bool) {
        _probe(msg.sender);
        return super.transfer(recipient, amount);
    }
    function transferFrom(address sender, address recipient, uint256 amount) public override returns (bool) {
        _probe(msg.sender);
        return super.transferFrom(sender, recipient, amount);
    }
    function _probe(address target) private {
        if (!probe || target.code.length == 0) return;
        bytes[] memory calls = new bytes[](9);
        calls[0] = abi.encodeCall(IndependentFundingEscrow.deposit, (1));
        calls[1] = abi.encodeCall(IndependentFundingEscrow.acceptFunding, ());
        calls[2] = abi.encodeCall(IndependentFundingEscrow.declineFunding, (bytes32(0)));
        calls[3] = abi.encodeCall(IndependentFundingEscrow.submitEvidence, (bytes32(0)));
        calls[4] = abi.encodeCall(IndependentFundingEscrow.voteCompletion, (0, bytes32(0), true));
        calls[5] = abi.encodeCall(IndependentFundingEscrow.releaseCompletion, ());
        calls[6] = abi.encodeCall(IndependentFundingEscrow.adminCancel, (bytes32(0)));
        calls[7] = abi.encodeCall(IndependentFundingEscrow.expire, ());
        calls[8] = abi.encodeCall(IndependentFundingEscrow.claimRefund, ());
        for (uint256 i; i < calls.length; i++) {
            (bool success, bytes memory reason) = target.call(calls[i]);
            if (success || bytes4(reason) != ReentrancyGuard.ReentrancyGuardReentrantCall.selector) revert GuardNotEnforced();
        }
        guardedCallbacks++;
    }
}
