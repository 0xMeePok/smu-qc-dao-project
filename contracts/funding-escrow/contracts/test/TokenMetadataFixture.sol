// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Local malformed-metadata fixture; not a funding token.
contract TokenMetadataFixture {
    enum Response { Missing, Reverting, Short, Long, OutOfUint8 }
    Response private immutable _response;

    constructor(Response response_) { _response = response_; }

    fallback() external {
        Response response = _response;
        if (response == Response.Reverting) revert();
        if (response == Response.Missing) return;
        if (response == Response.Short) {
            assembly ("memory-safe") { mstore(0, 6) return(31, 1) }
        }
        if (response == Response.Long) {
            assembly ("memory-safe") { mstore(0, 6) mstore(32, 0) return(0, 64) }
        }
        assembly ("memory-safe") { mstore(0, 256) return(0, 32) }
    }
}
