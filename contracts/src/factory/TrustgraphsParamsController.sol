// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {ParamsCodec} from "src/params/ParamsCodec.sol";
import {TrustgraphsParamsValidator} from "src/params/TrustgraphsParamsValidator.sol";
import {ITrustgraphsParamsController} from "interfaces/factory/ITrustgraphsParamsController.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @title TrustgraphsParamsController
/// @notice Publishes complete, validated parameter versions and coordinates their live hash.
/// @dev The snapshot remains program-agnostic. This typed controller is its sole operational-role
///      holder for factory-created trust graphs, while an EOA, Safe, or timelock owns this contract.
contract TrustgraphsParamsController is ITrustgraphsParamsController, Ownable2Step {
    bytes32 public immutable instanceId;
    address public immutable snapshot;
    IInstanceRegistry public immutable registry;
    address public immutable initialPublisher;

    uint64 public version;
    bytes32 public currentParamsHash;
    bool public versionOnePublished;

    ParamsCodec.Params private _initialParams;
    ParamsCodec.Params private _currentParams;

    error ZeroAddress();
    error InitialHashMismatch(bytes32 encoded, bytes32 live);
    error NoopUpdate(bytes32 paramsHash);
    error SnapshotHashMismatch(bytes32 expected, bytes32 actual);
    error RegistryHashMismatch(bytes32 expected, bytes32 actual);
    error RegistrySnapshotMismatch(address expected, address actual);
    error ControllerNotRegistered(address registeredAuthority);
    error InitialVersionAlreadyPublished();
    error InitialVersionNotPublished();
    error NotInitialPublisher(address caller);

    constructor(
        bytes32 instanceId_,
        address snapshot_,
        IInstanceRegistry registry_,
        ParamsCodec.Params memory initialParams,
        address initialOwner,
        address initialPublisher_
    ) Ownable(initialOwner) {
        if (snapshot_ == address(0) || address(registry_) == address(0) || initialPublisher_ == address(0)) revert ZeroAddress();

        TrustgraphsParamsValidator.validateFinal(initialParams);
        bytes32 encoded = ParamsCodec.hash(initialParams);
        bytes32 live = MerkleSnapshot(snapshot_).paramsHash();
        if (encoded != live) revert InitialHashMismatch(encoded, live);

        instanceId = instanceId_;
        snapshot = snapshot_;
        registry = registry_;
        initialPublisher = initialPublisher_;
        version = 1;
        currentParamsHash = encoded;
        _initialParams = initialParams;
        _currentParams = initialParams;
    }

    function getCurrentParams() external view returns (ParamsCodec.Params memory) {
        return _currentParams;
    }

    /// @notice Publish version 1 after the discovery/association event that makes this address known.
    /// @dev This ordering matters to streaming indexers: a constructor log predates the factory log
    ///      that teaches them which child address to watch.
    function publishInitialVersion() external {
        if (msg.sender != initialPublisher) revert NotInitialPublisher(msg.sender);
        if (versionOnePublished) revert InitialVersionAlreadyPublished();
        versionOnePublished = true;
        emit ParamsUpdated(instanceId, 1, currentParamsHash, bytes32(0), _currentParams, "");
    }

    function updateParams(ParamsCodec.Params calldata next, string calldata evidenceURI)
        external
        onlyOwner
        returns (uint64 newVersion, bytes32 newHash)
    {
        if (!versionOnePublished) revert InitialVersionNotPublished();
        ParamsCodec.Params memory nextMemory = next;
        TrustgraphsParamsValidator.validateUpdate(nextMemory, _initialParams);

        bytes32 previousHash = currentParamsHash;
        newHash = ParamsCodec.hash(nextMemory);
        if (newHash == previousHash) revert NoopUpdate(newHash);

        bytes32 snapshotHash = MerkleSnapshot(snapshot).paramsHash();
        if (snapshotHash != previousHash) revert SnapshotHashMismatch(previousHash, snapshotHash);

        IInstanceRegistry.Instance memory record = registry.getInstance(instanceId);
        if (record.snapshot != snapshot) revert RegistrySnapshotMismatch(snapshot, record.snapshot);
        if (record.paramsHash != previousHash) revert RegistryHashMismatch(previousHash, record.paramsHash);
        address authority = registry.paramsAuthority(instanceId);
        if (authority != address(this)) revert ControllerNotRegistered(authority);

        // The external calls and local write are one transaction: failure in any leg rolls back all.
        MerkleSnapshot(snapshot).setParamsHash(newHash);
        registry.updateParamsHash(instanceId, newHash);

        newVersion = version + 1;
        version = newVersion;
        currentParamsHash = newHash;
        _currentParams = nextMemory;

        emit ParamsUpdated(instanceId, newVersion, newHash, previousHash, nextMemory, evidenceURI);
    }
}
