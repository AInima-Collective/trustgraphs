// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @title ICompositionSourceAdapter
/// @notice Authenticated, immutable view of one governance-admitted source lineage/program.
interface ICompositionSourceAdapter {
    struct CapturedState {
        uint64 stateIndex;
        uint64 freezeBlock;
        bytes32 outputRoot;
        bytes32 blobSha256;
        bytes32 cidDigest;
        uint128 totalValue;
        uint256 checkpointId;
        uint64 acceptedAtBlock;
        bytes32 paramsHash;
        address verifier;
        bytes32 verifierCodehash;
        bytes32 programVKey;
    }

    function chainId() external view returns (uint64);
    function sourceId() external view returns (bytes32);
    function snapshot() external view returns (address);
    function familyId() external view returns (bytes32);
    function programId() external view returns (bytes32);
    function outputKind() external view returns (bytes32);
    function deploymentProvenance() external view returns (bytes32);
    function readLatest() external view returns (CapturedState memory);
    function readAt(uint256 stateIndex) external view returns (CapturedState memory);
    function readCheckpoint(uint256 checkpointId) external view returns (CapturedState memory);
}

interface ICompositionSourceAdapterFactory {
    function registry() external view returns (IInstanceRegistry);
    function isAdapter(address adapter) external view returns (bool);
}
