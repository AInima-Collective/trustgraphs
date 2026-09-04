// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Safe} from "@safe-global/safe-smart-account/Safe.sol";
import {SafeProxyFactory} from "@safe-global/safe-smart-account/proxies/SafeProxyFactory.sol";

import {GovernedFactoryBase} from "src/factory/GovernedFactoryBase.sol";
import {ImportedTrustgraphsFactory} from "src/factory/ImportedTrustgraphsFactory.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    ParentAuthorityModuleDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {ISubnetworkRegistry} from "interfaces/registry/ISubnetworkRegistry.sol";

/// @title GovernedImportedTrustgraphsFactory
/// @notice DAO-governed wrapper for the existing-EAS-schema instance flavor.
contract GovernedImportedTrustgraphsFactory is GovernedFactoryBase {
    constructor(
        ImportedTrustgraphsFactory factory_,
        SafeProxyFactory safeFactory_,
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

    function createGovernedImportedInstance(
        TrustgraphsFactory.CreateArgs calldata requested,
        bytes32 importedSchemaUid,
        InitialPolicy calldata policy,
        SignerSyncConfig calldata signerSync
    ) external payable returns (bytes32 instanceId, address safeAddress, address merkleGovModule, address snapshot) {
        _requirePrepayTerms(policy, requested.epochLength);
        Safe safe = _createBootstrapSafe(msg.sender, requested.name, requested.salt);

        TrustgraphsFactory.CreateArgs memory args = requested;
        args.admin = address(safe);
        return _installGovernedInstance(
            safe,
            requested.name,
            requested.salt,
            abi.encodeCall(ImportedTrustgraphsFactory.createImportedInstance, (args, importedSchemaUid)),
            policy,
            signerSync
        );
    }
}
