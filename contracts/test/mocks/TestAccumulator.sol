// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {AttestationAccumulator} from "src/eas/AttestationAccumulator.sol";

/// @notice Concrete harness exposing the internal `_fold` for unit-testing the real accumulator.
contract TestAccumulator is AttestationAccumulator {
    function fold(uint8 kind, address attester, address recipient, bytes32 uid, bytes32 dataHash) external {
        _fold(kind, attester, recipient, uid, dataHash);
    }
}
