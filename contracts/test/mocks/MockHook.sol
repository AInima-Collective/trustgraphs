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

/// @notice A hook that always reverts, to prove a misbehaving consumer cannot block proof submission.
contract RevertingHook is IMerkleSnapshotHook {
    error HookReverted();

    function onMerkleUpdate(IMerkleSnapshot.MerkleState memory) external pure {
        revert HookReverted();
    }
}

/// @notice A hook that burns all forwarded gas, to prove the per-hook stipend bounds a griefer.
contract GasGuzzlerHook is IMerkleSnapshotHook {
    function onMerkleUpdate(IMerkleSnapshot.MerkleState memory) external pure {
        uint256 i;
        while (true) {
            unchecked {
                i++;
            }
            // keccak in a loop to consume gas quickly; will hit the stipend and be caught.
            keccak256(abi.encode(i));
        }
    }
}
