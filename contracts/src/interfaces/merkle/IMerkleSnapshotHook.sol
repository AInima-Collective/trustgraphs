// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IMerkleSnapshot} from "./IMerkleSnapshot.sol";

/// @title IMerkleSnapshotHook
/// @notice Interface that lets a contract receive a hook from the MerkleSnapshot contract when the merkle state is updated.
interface IMerkleSnapshotHook {
    function onMerkleUpdate(IMerkleSnapshot.MerkleState memory state) external;
}
