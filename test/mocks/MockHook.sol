// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IMerkleSnapshotHook} from "interfaces/merkle/IMerkleSnapshotHook.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";

/// @notice Records hook invocations for testing that snapshots still fire hooks.
contract MockHook is IMerkleSnapshotHook {
    uint256 public calls;
    bytes32 public lastRoot;

    function onMerkleUpdate(IMerkleSnapshot.MerkleState memory state) external {
        calls++;
        lastRoot = state.root;
    }
}
