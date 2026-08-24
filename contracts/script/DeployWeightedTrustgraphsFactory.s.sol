// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";

import {SchemaRegistrar} from "src/eas/SchemaRegistrar.sol";
import {WeightedTrustgraphsFactory} from "src/factory/WeightedTrustgraphsFactory.sol";
import {WeightedPriorParamsControllerDeployer} from "src/factory/WeightedInstanceDeployers.sol";
import {MerkleSnapshotDeployer, MerkleFundDistributorDeployer} from "src/factory/InstanceDeployers.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";

import {Common} from "script/Common.s.sol";

/// @title DeployWeightedTrustgraphsFactory
/// @notice Stands up the permissionless `trust-graph-weighted` instance factory: the three
///         creation-code deployers, the `WeightedTrustgraphsFactory` itself, and the
///         `REGISTRAR_ROLE` grant that lets it register into the chain's `InstanceRegistry`.
///
/// @dev Runs AFTER `DeployEAS`, `DeployZkVerifier` (with the WEIGHTED program's vkey — outLabel
///      `weighted`, NOT the trust-graph root verifier) and `DeployInstanceRegistry`. Same grant
///      bootstrap as `DeployFactory`: at bootstrap the deployer is the registry admin; once
///      registry admin has moved to the operational timelock the grant becomes a governance action
///      and this script's grant step is skipped (`GRANT_REGISTRAR=false`).
contract DeployWeightedTrustgraphsFactory is Common {
    using stdJson for string;

    string public root = vm.projectRoot();

    /// @notice Deploy the weighted factory and wire it to the registry.
    /// @param easAddr The chain's EAS.
    /// @param schemaRegistrarAddr The shared schema registrar.
    /// @param zkVerifierAddr The `SP1JournalVerifier` pinned to the `trust-graph-weighted` guest's
    ///        vkey (`cargo run -p trustgraph-prover -- trust-graph-weighted vkey`). Passing the
    ///        trust-graph root verifier here would create instances no weighted proof can satisfy.
    /// @param instanceRegistryAddr The chain's `InstanceRegistry`.
    /// @param epochFloor Minimum epoch length in blocks (mainnet: ~30 days; anvil: small).
    /// @param priorActivationDelay Seconds between `proposePrior` and the earliest `activatePrior`.
    ///        IMMUTABLE on the factory and copied into every controller it deploys — this is the
    ///        review window in which operators re-verify a proposed prior's exact bytes.
    /// @param provingVaultAddr The chain's `ProvingVault`, or "" for none. Empty falls back to the
    ///        `PROVING_VAULT` environment variable, and zero disables the prepay path — a factory
    ///        with no vault reverts on any `msg.value` rather than silently keeping it. IMMUTABLE.
    /// @return factory The deployed `WeightedTrustgraphsFactory`.
    function run(
        string calldata easAddr,
        string calldata schemaRegistrarAddr,
        string calldata zkVerifierAddr,
        string calldata instanceRegistryAddr,
        uint64 epochFloor,
        uint48 priorActivationDelay,
        string memory provingVaultAddr
    ) public returns (address factory) {
        address eas = vm.parseAddress(easAddr);
        address schemaRegistrar = vm.parseAddress(schemaRegistrarAddr);
        address zkVerifier = vm.parseAddress(zkVerifierAddr);
        address instanceRegistry = vm.parseAddress(instanceRegistryAddr);

        require(eas != address(0), "DeployWeightedTrustgraphsFactory: eas is zero");
        require(schemaRegistrar != address(0), "DeployWeightedTrustgraphsFactory: schemaRegistrar is zero");
        require(zkVerifier != address(0), "DeployWeightedTrustgraphsFactory: zkVerifier is zero");
        require(instanceRegistry != address(0), "DeployWeightedTrustgraphsFactory: instanceRegistry is zero");
        require(epochFloor > 0, "DeployWeightedTrustgraphsFactory: epochFloor is zero");
        // Same fail-closed floor as `DeployFactory`: the floor is IMMUTABLE and bounds hosted
        // proving cost per instance, so the 1-block dev default must not reach a real chain.
        require(
            block.chainid == 31337 || epochFloor >= 7200,
            "DeployWeightedTrustgraphsFactory: epochFloor too low for a non-dev chain (>= ~1 day of blocks)"
        );
        require(priorActivationDelay > 0, "DeployWeightedTrustgraphsFactory: priorActivationDelay is zero");
        // The delay is the runbook's operator review window (research/operations/weighted-prior/runbook.md
        // "Activate"): during it every proving operator re-fetches and re-verifies the proposed
        // manifest bytes. A seconds-long dev default reaching a real chain would make rotation
        // effectively instant, so anything under a day cannot be deliberate off-devnet.
        require(
            block.chainid == 31337 || priorActivationDelay >= 1 days,
            "DeployWeightedTrustgraphsFactory: priorActivationDelay too short for a non-dev chain (>= 1 day)"
        );

        // Zero disables the prepay path on this factory; `createInstance` then reverts on any
        // `msg.value` rather than silently keeping it.
        IProvingVault vault = IProvingVault(
            bytes(provingVaultAddr).length > 0
                ? vm.parseAddress(provingVaultAddr)
                : vm.envOr("PROVING_VAULT", address(0))
        );

        _startBroadcast();

        // The children whose creation code will not fit inside the factory (EIP-170).
        MerkleSnapshotDeployer snapshotDeployer = new MerkleSnapshotDeployer();
        MerkleFundDistributorDeployer distributorDeployer = new MerkleFundDistributorDeployer();
        WeightedPriorParamsControllerDeployer paramsControllerDeployer = new WeightedPriorParamsControllerDeployer();

        WeightedTrustgraphsFactory weightedFactory = new WeightedTrustgraphsFactory(
            IEAS(eas),
            SchemaRegistrar(schemaRegistrar),
            IZkVerifier(zkVerifier),
            IInstanceRegistry(instanceRegistry),
            snapshotDeployer,
            distributorDeployer,
            paramsControllerDeployer,
            epochFloor,
            priorActivationDelay,
            vault
        );
        factory = address(weightedFactory);

        // The factory's ONLY privilege anywhere: it may APPEND rows to the directory.
        // `REGISTRAR_ROLE`, deliberately NOT `OPERATOR_ROLE` — the latter also grants `update()`,
        // i.e. the power to re-point any existing community's record. Mirrors `DeployFactory`.
        if (vm.envOr("GRANT_REGISTRAR", true)) {
            InstanceRegistry registry = InstanceRegistry(instanceRegistry);
            registry.grantRole(registry.REGISTRAR_ROLE(), factory);
            // Assert rather than assume — `envOr` treats anything non-false as true, so a typo'd
            // opt-out reads as "on" and a failed grant would only surface on the first creation.
            require(
                registry.hasRole(registry.REGISTRAR_ROLE(), factory),
                "DeployWeightedTrustgraphsFactory: REGISTRAR_ROLE grant failed"
            );
            require(
                !registry.hasRole(registry.OPERATOR_ROLE(), factory),
                "DeployWeightedTrustgraphsFactory: factory must not hold OPERATOR_ROLE"
            );
        }

        vm.stopBroadcast();

        console.log("ProvingVault:", address(vault), address(vault) == address(0) ? "(no prepay path)" : "");
        console.log("MerkleSnapshotDeployer:", address(snapshotDeployer));
        console.log("MerkleFundDistributorDeployer:", address(distributorDeployer));
        console.log("WeightedPriorParamsControllerDeployer:", address(paramsControllerDeployer));
        console.log("WeightedTrustgraphsFactory:", factory);
        console.log("epochFloor (blocks):", epochFloor);
        console.log("priorActivationDelay (seconds):", priorActivationDelay);

        string memory _json = "json";
        _json.serialize("instance_registry", Strings.toChecksumHexString(instanceRegistry));
        _json.serialize("zk_verifier", Strings.toChecksumHexString(zkVerifier));
        _json.serialize("snapshot_deployer", Strings.toChecksumHexString(address(snapshotDeployer)));
        _json.serialize("distributor_deployer", Strings.toChecksumHexString(address(distributorDeployer)));
        _json.serialize("params_controller_deployer", Strings.toChecksumHexString(address(paramsControllerDeployer)));
        _json.serialize("epoch_floor", uint256(epochFloor));
        _json.serialize("prior_activation_delay_seconds", uint256(priorActivationDelay));
        string memory finalJson = _json.serialize("weighted_factory", Strings.toChecksumHexString(factory));
        vm.writeFile(string.concat(root, "/.docker/weighted_factory_deploy.json"), finalJson);
    }
}
