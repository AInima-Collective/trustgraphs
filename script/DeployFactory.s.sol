// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";

import {SchemaRegistrar} from "contracts/eas/SchemaRegistrar.sol";
import {TrustgraphsFactory} from "contracts/factory/TrustgraphsFactory.sol";
import {
    MerkleSnapshotDeployer,
    MerkleFundDistributorDeployer,
    TrustgraphsParamsControllerDeployer
} from "contracts/factory/InstanceDeployers.sol";
import {InstanceRegistry} from "contracts/registry/InstanceRegistry.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";

import {Common} from "script/Common.s.sol";

/// @title DeployFactory
/// @notice Stands up the permissionless instance factory: the two creation-code deployers, the
///         `TrustgraphsFactory` itself, and the `OPERATOR_ROLE` grant that lets it register into the
///         chain's `InstanceRegistry`.
///
/// @dev Runs AFTER `DeployEAS`, `DeployZkVerifier` and `DeployInstanceRegistry` — it consumes all
///      three. The grant needs the registry's admin key, which at bootstrap is the deployer; once
///      the registry admin has moved to the operational timelock, the grant becomes a governance
///      action instead and this script's grant step is skipped (`GRANT_REGISTRAR=false`).
contract DeployFactory is Common {
    using stdJson for string;

    string public root = vm.projectRoot();

    /// @notice Deploy the factory and wire it to the registry.
    /// @param easAddr The chain's EAS.
    /// @param schemaRegistrarAddr The shared schema registrar.
    /// @param zkVerifierAddr The shared trust-graph `SP1JournalVerifier`.
    /// @param instanceRegistryAddr The chain's `InstanceRegistry`.
    /// @param epochFloor Minimum epoch length in blocks (mainnet: ~30 days; anvil: small).
    /// @return factory The deployed `TrustgraphsFactory`.
    function run(
        string calldata easAddr,
        string calldata schemaRegistrarAddr,
        string calldata zkVerifierAddr,
        string calldata instanceRegistryAddr,
        uint64 epochFloor
    ) public returns (address factory) {
        return run(easAddr, schemaRegistrarAddr, zkVerifierAddr, instanceRegistryAddr, epochFloor, "");
    }

    /// @notice Deploy the factory, naming the `ProvingVault` prepay goes to.
    /// @param provingVaultAddr The chain's `ProvingVault`, or "" for none. Empty falls back to the
    ///        `PROVING_VAULT` environment variable, and zero disables the prepay path — a factory
    ///        with no vault reverts on any `msg.value` rather than silently keeping it. IMMUTABLE,
    ///        so a factory deployed before its vault can never be given one.
    function run(
        string calldata easAddr,
        string calldata schemaRegistrarAddr,
        string calldata zkVerifierAddr,
        string calldata instanceRegistryAddr,
        uint64 epochFloor,
        string memory provingVaultAddr
    ) public returns (address factory) {
        address eas = vm.parseAddress(easAddr);
        address schemaRegistrar = vm.parseAddress(schemaRegistrarAddr);
        address zkVerifier = vm.parseAddress(zkVerifierAddr);
        address instanceRegistry = vm.parseAddress(instanceRegistryAddr);

        require(eas != address(0), "DeployFactory: eas is zero");
        require(schemaRegistrar != address(0), "DeployFactory: schemaRegistrar is zero");
        require(zkVerifier != address(0), "DeployFactory: zkVerifier is zero");
        require(instanceRegistry != address(0), "DeployFactory: instanceRegistry is zero");
        require(epochFloor > 0, "DeployFactory: epochFloor is zero");
        // The floor is IMMUTABLE and it is what bounds hosted proving cost per instance, so a dev
        // default must not reach a real chain. `deploy/env.ts` hardcodes 1 block for local anvil
        // and `DEPLOY_ENV` defaults to `dev`, which makes "unset env + real RPC" a one-typo path to
        // a permissionless factory whose floor is one block. Roughly a day of blocks is the least
        // that could be deliberate; mainnet's intended value is ~30 days (216000).
        require(
            block.chainid == 31337 || epochFloor >= 7200,
            "DeployFactory: epochFloor too low for a non-dev chain (>= ~1 day of blocks)"
        );

        // Zero disables the prepay path on this factory; `createInstance` then reverts on any
        // `msg.value` rather than silently keeping it.
        IProvingVault vault = IProvingVault(
            bytes(provingVaultAddr).length > 0
                ? vm.parseAddress(provingVaultAddr)
                : vm.envOr("PROVING_VAULT", address(0))
        );

        vm.startBroadcast(_privateKey);

        // The two children whose creation code will not fit inside the factory (EIP-170).
        MerkleSnapshotDeployer snapshotDeployer = new MerkleSnapshotDeployer();
        MerkleFundDistributorDeployer distributorDeployer = new MerkleFundDistributorDeployer();
        TrustgraphsParamsControllerDeployer paramsControllerDeployer = new TrustgraphsParamsControllerDeployer();

        TrustgraphsFactory trustgraphsFactory = new TrustgraphsFactory(
            IEAS(eas),
            SchemaRegistrar(schemaRegistrar),
            IZkVerifier(zkVerifier),
            IInstanceRegistry(instanceRegistry),
            snapshotDeployer,
            distributorDeployer,
            paramsControllerDeployer,
            epochFloor,
            vault
        );
        factory = address(trustgraphsFactory);

        // The factory's ONLY privilege anywhere: it may APPEND rows to the directory.
        // `REGISTRAR_ROLE`, deliberately NOT `OPERATOR_ROLE` — the latter also grants `update()`,
        // i.e. the power to re-point any existing community's record at a snapshot and verifier of
        // the caller's choosing. A factory bug can add garbage entries; it can never rewrite one.
        if (vm.envOr("GRANT_REGISTRAR", true)) {
            InstanceRegistry registry = InstanceRegistry(instanceRegistry);
            registry.grantRole(registry.REGISTRAR_ROLE(), factory);
            // Assert rather than assume. `envOr` treats anything non-false as true, so without this
            // a typo'd opt-out reads as "on" and a failed grant would only surface when the first
            // community's creation reverts.
            require(registry.hasRole(registry.REGISTRAR_ROLE(), factory), "DeployFactory: REGISTRAR_ROLE grant failed");
            require(
                !registry.hasRole(registry.OPERATOR_ROLE(), factory),
                "DeployFactory: factory must not hold OPERATOR_ROLE"
            );
        }

        vm.stopBroadcast();

        console.log("ProvingVault:", address(vault), address(vault) == address(0) ? "(no prepay path)" : "");
        console.log("MerkleSnapshotDeployer:", address(snapshotDeployer));
        console.log("MerkleFundDistributorDeployer:", address(distributorDeployer));
        console.log("TrustgraphsParamsControllerDeployer:", address(paramsControllerDeployer));
        console.log("TrustgraphsFactory:", factory);
        console.log("epochFloor (blocks):", epochFloor);

        string memory _json = "json";
        _json.serialize("instance_registry", Strings.toChecksumHexString(instanceRegistry));
        _json.serialize("snapshot_deployer", Strings.toChecksumHexString(address(snapshotDeployer)));
        _json.serialize("distributor_deployer", Strings.toChecksumHexString(address(distributorDeployer)));
        _json.serialize("params_controller_deployer", Strings.toChecksumHexString(address(paramsControllerDeployer)));
        _json.serialize("epoch_floor", uint256(epochFloor));
        string memory finalJson = _json.serialize("factory", Strings.toChecksumHexString(factory));
        vm.writeFile(string.concat(root, "/.docker/factory_deploy.json"), finalJson);
    }
}
