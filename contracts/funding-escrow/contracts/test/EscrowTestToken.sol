// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {FundingEscrow} from "../FundingEscrow.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Local regression fixture only. Never configure this as a deployed funding token.
contract EscrowTestToken is ERC20 {
    enum Behavior { Standard, FalseReturn, NoReturn, RecipientFee, SenderFee, NoMovement, Reverting }
    Behavior public behavior;
    uint8 private _decimals;
    bool public metadataReverts;
    bool public changeDecimalsOnTransfer;
    bool public probeCallbacks;
    uint256 public guardedCallbacks;
    address public blockedRecipient;
    error TestTransferRejected();
    error GuardNotEnforced();

    constructor(uint8 decimals_) ERC20("Escrow test token", "TEST") { _decimals = decimals_; }
    function decimals() public view override returns (uint8) {
        if (metadataReverts) revert TestTransferRejected();
        return _decimals;
    }
    function setDecimals(uint8 value) external { _decimals = value; }
    function setMetadataReverts(bool value) external { metadataReverts = value; }
    function setChangeDecimalsOnTransfer(bool value) external { changeDecimalsOnTransfer = value; }
    function mint(address recipient, uint256 amount) external { _mint(recipient, amount); }
    function configure(Behavior behavior_, bool probeCallbacks_) external {
        behavior = behavior_;
        probeCallbacks = probeCallbacks_;
    }
    function blockRecipient(address recipient) external { blockedRecipient = recipient; }

    function transfer(address recipient, uint256 amount) public override returns (bool) {
        return _testTransfer(msg.sender, recipient, amount);
    }
    function transferFrom(address sender, address recipient, uint256 amount) public override returns (bool) {
        _spendAllowance(sender, msg.sender, amount);
        return _testTransfer(sender, recipient, amount);
    }
    function _testTransfer(address sender, address recipient, uint256 amount) private returns (bool) {
        if (recipient == blockedRecipient || behavior == Behavior.Reverting) revert TestTransferRejected();
        if (behavior == Behavior.FalseReturn) return false;
        if (changeDecimalsOnTransfer) _decimals = _decimals == 6 ? 18 : 6;
        if (probeCallbacks) _assertGuard(FundingEscrow(msg.sender));
        if (behavior == Behavior.NoMovement) return true;
        if (behavior == Behavior.RecipientFee) {
            _transfer(sender, recipient, amount - 1);
            _burn(sender, 1);
        } else {
            _transfer(sender, recipient, amount);
            if (behavior == Behavior.SenderFee) _burn(sender, 1);
        }
        if (behavior == Behavior.NoReturn) {
            assembly ("memory-safe") { return(0, 0) }
        }
        return true;
    }

    // Fixed callback regression checks cover all mutating escrow entry points.
    function _assertGuard(FundingEscrow escrow) private {
        try escrow.deposit(1) { revert GuardNotEnforced(); } catch (bytes memory reason) { _check(reason); }
        try escrow.claimRefund() { revert GuardNotEnforced(); } catch (bytes memory reason) { _check(reason); }
        try escrow.expire() { revert GuardNotEnforced(); } catch (bytes memory reason) { _check(reason); }
        try escrow.release(bytes32(0)) { revert GuardNotEnforced(); } catch (bytes memory reason) { _check(reason); }
        try escrow.approveSelection(bytes32(0)) { revert GuardNotEnforced(); } catch (bytes memory reason) { _check(reason); }
        try escrow.lockSelection(bytes32(0), address(0)) { revert GuardNotEnforced(); } catch (bytes memory reason) { _check(reason); }
        try escrow.invalidateSelection(bytes32(0), bytes32(0)) { revert GuardNotEnforced(); } catch (bytes memory reason) { _check(reason); }
        try escrow.cancel(bytes32(0)) { revert GuardNotEnforced(); } catch (bytes memory reason) { _check(reason); }
        try escrow.submitMilestone(1, bytes32(0)) { revert GuardNotEnforced(); } catch (bytes memory reason) { _check(reason); }
        try escrow.approveMilestone(bytes32(0), 1, bytes32(0)) { revert GuardNotEnforced(); } catch (bytes memory reason) { _check(reason); }
        try escrow.voteMilestone(1, bytes32(0), true) { revert GuardNotEnforced(); } catch (bytes memory reason) { _check(reason); }
        try escrow.releaseMilestone(bytes32(0), 1, bytes32(0)) { revert GuardNotEnforced(); } catch (bytes memory reason) { _check(reason); }
        try escrow.voidEscrow(bytes32(0)) { revert GuardNotEnforced(); } catch (bytes memory reason) { _check(reason); }
        try escrow.refundInvalidated() { revert GuardNotEnforced(); } catch (bytes memory reason) { _check(reason); }
        guardedCallbacks += 1;
    }
    function _check(bytes memory reason) private pure {
        if (bytes4(reason) != ReentrancyGuard.ReentrancyGuardReentrantCall.selector) revert GuardNotEnforced();
    }
}
