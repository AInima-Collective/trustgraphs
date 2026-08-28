// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";

/// @title IMerkleSnapshotProvenance
/// @notice Source-authentication seam kept separate from the core snapshot interface.
interface IMerkleSnapshotProvenance {
    error ProvenanceEnableAfterState(uint256 stateCount);

    event StateProvenanceEnabled();

    struct StateProvenance {
        uint256 stateIndex;
        uint256 checkpointId;
        uint64 acceptedAtBlock;
        bytes32 paramsHash;
        address verifier;
        bytes32 verifierCodehash;
        bytes32 programVKey;
    }

    event StateProvenanceRecorded(
        uint256 indexed stateIndex,
        uint256 indexed checkpointId,
        uint64 indexed acceptedAtBlock,
        bytes32 paramsHash,
        address verifier,
        bytes32 verifierCodehash,
        bytes32 programVKey
    );

    function getStateProvenance(uint256 stateIndex) external view returns (StateProvenance memory);
    function provenanceEnabled() external view returns (bool);

    /// @notice Recover an accepted state by its never-reused checkpoint, even if another accepted
    ///         checkpoint later shared and replaced its block-indexed state slot.
    function getAcceptedCheckpoint(uint256 checkpointId)
        external
        view
        returns (IMerkleSnapshot.MerkleState memory state, StateProvenance memory provenance);
}
