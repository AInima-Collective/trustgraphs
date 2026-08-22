// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ISnapshotAccumulatorView} from "interfaces/merkle/ISnapshotAccumulatorView.sol";

/// @notice The smallest thing an accumulator's `bindSnapshot` will accept: a stand-in snapshot
///         that names the accumulator it is being bound to. Lets accumulator-level tests exercise
///         the bound path without dragging in the whole `MerkleSnapshot`.
contract MockSnapshotView is ISnapshotAccumulatorView {
    address public accumulator;

    constructor(address _accumulator) {
        accumulator = _accumulator;
    }

    /// @notice Forward a checkpoint call as the bound snapshot would.
    function mint(address acc) external returns (uint256) {
        (bool ok, bytes memory ret) = acc.call(abi.encodeWithSignature("checkpoint()"));
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return abi.decode(ret, (uint256));
    }
}
