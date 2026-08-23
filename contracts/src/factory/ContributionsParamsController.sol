// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {ContributionsParamsCodec} from "src/params/ContributionsParamsCodec.sol";
import {ContributionsParamsValidator} from "src/params/ContributionsParamsValidator.sol";
import {IContributionsParamsController} from "interfaces/factory/IContributionsParamsController.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @title ContributionsParamsController
/// @notice Publishes every complete contributions tuple and atomically rotates its live commitment.
/// @dev The event history is the durable params preimage. The snapshot remains program-agnostic;
///      this controller is its sole operational-role holder while an EOA, Safe, or timelock owns
///      this contract.
contract ContributionsParamsController is IContributionsParamsController, Ownable2Step {
    bytes32 public immutable instanceId;
    address public immutable snapshot;
    address public immutable eas;
    IInstanceRegistry public immutable registry;
    address public immutable initialPublisher;
    bytes32 public immutable claimSchemaUid;
    bytes32 public immutable responseSchemaUid;
    bytes32 public immutable valuationSchemaUid;

    uint64 public version;
    bytes32 public currentParamsHash;
    bool public versionOnePublished;

    ContributionsParamsCodec.Params private _currentParams;

    error ZeroAddress();
    error InitialHashMismatch(bytes32 encoded, bytes32 live);
    error NoopUpdate(bytes32 paramsHash);
    error IdentityFieldChanged();
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
        address eas_,
        IInstanceRegistry registry_,
        ContributionsParamsCodec.Params memory initialParams,
        address initialOwner,
        address initialPublisher_
    ) Ownable(initialOwner) {
        if (
            snapshot_ == address(0) || eas_ == address(0) || address(registry_) == address(0)
                || initialOwner == address(0) || initialPublisher_ == address(0)
        ) revert ZeroAddress();

        bytes32 encoded = ContributionsParamsCodec.hash(initialParams);
        bytes32 live = MerkleSnapshot(snapshot_).paramsHash();
        if (encoded != live) revert InitialHashMismatch(encoded, live);

        instanceId = instanceId_;
        snapshot = snapshot_;
        eas = eas_;
        registry = registry_;
        initialPublisher = initialPublisher_;
        claimSchemaUid = initialParams.claimSchemaUid;
        responseSchemaUid = initialParams.responseSchemaUid;
        valuationSchemaUid = initialParams.valuationSchemaUid;
        version = 1;
        currentParamsHash = encoded;
        _currentParams = initialParams;
    }

    function getContributionsParams() external view returns (ContributionsParamsCodec.Params memory) {
        return _currentParams;
    }

    /// @notice Publish version 1 after the registry events that make this controller discoverable.
    function publishInitialVersion() external {
        if (msg.sender != initialPublisher) revert NotInitialPublisher(msg.sender);
        if (versionOnePublished) revert InitialVersionAlreadyPublished();
        versionOnePublished = true;
        emit ContributionsParamsUpdated(instanceId, 1, currentParamsHash, bytes32(0), _currentParams, "");
    }

    /// @notice Rotate the full tuple, snapshot commitment, and registry copy in one transaction.
    function updateParams(ContributionsParamsCodec.Params calldata next, string calldata evidenceURI)
        external
        onlyOwner
        returns (uint64 newVersion, bytes32 newHash)
    {
        if (!versionOnePublished) revert InitialVersionNotPublished();
        ContributionsParamsCodec.Params memory nextMemory = next;
        if (
            nextMemory.claimSchemaUid != claimSchemaUid || nextMemory.responseSchemaUid != responseSchemaUid
                || nextMemory.valuationSchemaUid != valuationSchemaUid
        ) revert IdentityFieldChanged();
        ContributionsParamsValidator.validateFinal(nextMemory);

        bytes32 previousHash = currentParamsHash;
        newHash = ContributionsParamsCodec.hash(nextMemory);
        if (newHash == previousHash) revert NoopUpdate(newHash);

        bytes32 snapshotHash = MerkleSnapshot(snapshot).paramsHash();
        if (snapshotHash != previousHash) revert SnapshotHashMismatch(previousHash, snapshotHash);

        IInstanceRegistry.Instance memory record = registry.getInstance(instanceId);
        if (record.snapshot != snapshot) revert RegistrySnapshotMismatch(snapshot, record.snapshot);
        if (record.paramsHash != previousHash) revert RegistryHashMismatch(previousHash, record.paramsHash);
        address authority = registry.paramsAuthority(instanceId);
        if (authority != address(this)) revert ControllerNotRegistered(authority);

        MerkleSnapshot(snapshot).setParamsHash(newHash);
        registry.updateParamsHash(instanceId, newHash);

        newVersion = version + 1;
        version = newVersion;
        currentParamsHash = newHash;
        _currentParams = nextMemory;

        emit ContributionsParamsUpdated(instanceId, newVersion, newHash, previousHash, nextMemory, evidenceURI);
    }
}
