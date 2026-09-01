// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

import {GovernedFactoryBase} from "src/factory/GovernedFactoryBase.sol";
import {TrustComposeFactoryV2} from "src/factory/TrustComposeFactoryV2.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";

/// @title GovernedTrustComposeFactoryV2
/// @notice The governed wrapper around `TrustComposeFactoryV2`: one transaction creates
///         a trust-compose V2 network and a module-only DAO Safe with member governance, delayed
///         recovery, and a sealed owner-execution guard. See `GovernedFactoryBase` for the
///         shared mechanics.
contract GovernedTrustComposeFactoryV2 is GovernedFactoryBase {
    constructor(
        TrustComposeFactoryV2 factory_,
        GnosisSafeProxyFactory safeFactory_,
        address safeSingleton_,
        GovernedAuthorityDeployer authorityDeployer_,
        SignerSyncModuleDeployer signerSyncDeployer_,
        MerkleGovModuleDeployer govModuleDeployer_,
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
            signerSyncVerifier_,
            signerSyncProgramVKey_
        )
    {}

    /// @notice Create one DAO-governed trust-compose V2 network. `requested.admin` is deliberately
    ///         ignored: the newly-created Safe is the instance admin, controller owner and fund
    ///         owner.
    /// @param requested The canonical factory arguments; its effective epoch bounds paid cadence.
    /// @param policy Initial vault terms. Must be zero/zero without value and fully enabled with it.
    function createGovernedInstance(
        TrustComposeFactoryV2.CreateArgs calldata requested,
        InitialPolicy calldata policy,
        SignerSyncConfig calldata signerSync
    ) external payable returns (bytes32 instanceId, address safeAddress, address merkleGovModule, address snapshot) {
        _requirePrepayTerms(policy, requested.epochLength);
        GnosisSafe safe = _createBootstrapSafe(msg.sender, requested.name, requested.salt);

        TrustComposeFactoryV2.CreateArgs memory args = requested;
        args.admin = address(safe);
        return _installGovernedInstance(
            safe,
            requested.name,
            requested.salt,
            abi.encodeCall(TrustComposeFactoryV2.createInstance, (args)),
            policy,
            signerSync
        );
    }
}
