// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

import {GovernedFactoryBase} from "src/factory/GovernedFactoryBase.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    ParentAuthorityModuleDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {ISubnetworkRegistry} from "interfaces/registry/ISubnetworkRegistry.sol";

/// @title GovernedTrustgraphsFactory
/// @notice The governed wrapper around `TrustgraphsFactory`: one transaction creates a trust
///         graph and a module-only DAO Safe with member governance, delayed recovery, and a
///         sealed owner-execution guard. See `GovernedFactoryBase` for the shared mechanics.
contract GovernedTrustgraphsFactory is GovernedFactoryBase {
    /// @notice Signer-sync must never rotate owners from a score root that also depends on
    ///         strict off-chain history; the hybrid entry point therefore refuses it.
    error HybridSignerSyncUnsupported();

    constructor(
        TrustgraphsFactory factory_,
        GnosisSafeProxyFactory safeFactory_,
        address safeSingleton_,
        GovernedAuthorityDeployer authorityDeployer_,
        SignerSyncModuleDeployer signerSyncDeployer_,
        MerkleGovModuleDeployer govModuleDeployer_,
        ParentAuthorityModuleDeployer parentAuthorityDeployer_,
        ISubnetworkRegistry subnetworkRegistry_,
        IZkVerifier signerSyncVerifier_,
        bytes32 signerSyncProgramVKey_
    )
        GovernedFactoryBase(
            address(factory_),
            safeFactory_,
            safeSingleton_,
            authorityDeployer_,
            signerSyncDeployer_,
            govModuleDeployer_,
            parentAuthorityDeployer_,
            subnetworkRegistry_,
            signerSyncVerifier_,
            signerSyncProgramVKey_
        )
    {}

    /// @notice Create and atomically link a DAO-governed trust graph beneath a parent network.
    /// @dev Must be called by the parent's current authority (normally from a parent proposal).
    function createGovernedSubnetwork(
        TrustgraphsFactory.CreateArgs calldata requested,
        InitialPolicy calldata policy,
        SignerSyncConfig calldata signerSync,
        bytes32 parentInstanceId,
        SubnetworkTier tier
    ) external payable returns (bytes32 instanceId, address safeAddress, address merkleGovModule, address snapshot) {
        _requirePrepayTerms(policy, requested.epochLength);
        _requireParentAuthority(parentInstanceId);
        GnosisSafe safe = _createBootstrapSafe(msg.sender, requested.name, requested.salt);

        TrustgraphsFactory.CreateArgs memory args = requested;
        args.admin = address(safe);
        return _installGovernedSubnetwork(
            safe,
            requested.name,
            requested.salt,
            abi.encodeCall(TrustgraphsFactory.createInstance, (args)),
            policy,
            signerSync,
            parentInstanceId,
            tier
        );
    }

    /// @notice Create one DAO-governed trust graph. `requested.admin` is deliberately ignored:
    ///         the newly-created Safe is the instance admin, controller owner and fund owner.
    /// @param requested The canonical factory arguments; its effective epoch bounds paid cadence.
    /// @param policy Initial vault terms. Must be zero/zero without value and fully enabled with it.
    function createGovernedInstance(
        TrustgraphsFactory.CreateArgs calldata requested,
        InitialPolicy calldata policy,
        SignerSyncConfig calldata signerSync
    ) external payable returns (bytes32 instanceId, address safeAddress, address merkleGovModule, address snapshot) {
        _requirePrepayTerms(policy, requested.epochLength);
        GnosisSafe safe = _createBootstrapSafe(msg.sender, requested.name, requested.salt);

        TrustgraphsFactory.CreateArgs memory args = requested;
        args.admin = address(safe);
        return _installGovernedInstance(
            safe,
            requested.name,
            requested.salt,
            abi.encodeCall(TrustgraphsFactory.createInstance, (args)),
            policy,
            signerSync
        );
    }

    /// @notice Create a governed strict-hybrid instance. Signer-sync is deliberately unavailable:
    ///         its current guest authenticates lane 1 only and must never rotate owners from a
    ///         score root that also depends on strict off-chain history.
    function createGovernedHybridInstance(
        TrustgraphsFactory.CreateArgs calldata requested,
        TrustgraphsFactory.OffchainEasConfig calldata offchain,
        InitialPolicy calldata policy,
        SignerSyncConfig calldata signerSync
    ) external payable returns (bytes32 instanceId, address safeAddress, address merkleGovModule, address snapshot) {
        if (signerSync.enabled) revert HybridSignerSyncUnsupported();
        _requirePrepayTerms(policy, requested.epochLength);
        GnosisSafe safe = _createBootstrapSafe(msg.sender, requested.name, requested.salt);

        TrustgraphsFactory.CreateArgs memory args = requested;
        args.admin = address(safe);
        return _installGovernedInstance(
            safe,
            requested.name,
            requested.salt,
            abi.encodeCall(TrustgraphsFactory.createHybridInstance, (args, offchain)),
            policy,
            signerSync
        );
    }
}
