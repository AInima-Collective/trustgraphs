// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";

/// @title NostrWorkspaceParamsAuthority
/// @notice Immutable v1 params authority for a member-scoped Nostr workspace pilot.
/// @dev The complete params preimage lives in the authorized operator/archive configuration and
///      is independently hashed before proving. This contract deliberately exposes no rotation
///      method: replacing the relay key, community, limits, or archive policy is a reviewed
///      replacement-instance operation for v1, not a partial live mutation.
contract NostrWorkspaceParamsAuthority {
    bytes32 public immutable instanceId;
    address public immutable snapshot;
    bytes32 public immutable currentParamsHash;
    uint64 public constant version = 1;

    error ZeroAddress();
    error InitialHashMismatch(bytes32 expected, bytes32 live);

    constructor(bytes32 instanceId_, address snapshot_, bytes32 paramsHash_) {
        if (snapshot_ == address(0) || paramsHash_ == bytes32(0)) revert ZeroAddress();
        bytes32 live = MerkleSnapshot(snapshot_).paramsHash();
        if (live != paramsHash_) revert InitialHashMismatch(paramsHash_, live);
        instanceId = instanceId_;
        snapshot = snapshot_;
        currentParamsHash = paramsHash_;
    }
}
