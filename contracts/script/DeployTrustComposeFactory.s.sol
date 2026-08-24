// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {CompositionSourceAdapterFactory} from "src/composition/CompositionSourceAdapter.sol";
import {TrustComposeFactory} from "src/factory/TrustComposeFactory.sol";
import {
    CompositionSourceAccumulatorDeployer,
    TrustComposeParamsControllerDeployer
} from "src/factory/TrustComposeInstanceDeployers.sol";
import {MerkleSnapshotDeployer, MerkleFundDistributorDeployer} from "src/factory/InstanceDeployers.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {ICompositionSourceAdapterFactory} from "interfaces/composition/ICompositionSourceAdapter.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";

import {Common} from "script/Common.s.sol";

/// @title DeployTrustComposeFactory
/// @notice Stands up the permissionless `trust-compose` instance factory: the
///         `CompositionSourceAdapterFactory` (the append-only registry of reviewed source
///         adapters), the four creation-code deployers, the `TrustComposeFactory` itself, and the
///         `REGISTRAR_ROLE` grant that lets it register into the chain's `InstanceRegistry`.
///
/// @dev Runs AFTER `DeployZkVerifier` (with the COMPOSITION program's vkey — outLabel
///      `composition`, NOT the trust-graph root verifier) and `DeployInstanceRegistry`. The
///      factory's constructor cross-checks the vkey passed here against the verifier's own
///      `programVKey()` and reverts on a mismatch, so pointing this script at the wrong verifier
///      artifact fails at deploy time instead of at the first proof. Same grant bootstrap as
///      `DeployFactory` (`GRANT_REGISTRAR=false` once registry admin has moved to the timelock).
contract DeployTrustComposeFactory is Common {
    using stdJson for string;

    string public root = vm.projectRoot();

    /// @notice Deploy the trust-compose factory and wire it to the registry.
    /// @param zkVerifierAddr The `SP1JournalVerifier` pinned to the `trust-compose` guest's vkey
    ///        (`cargo run -p trustgraph-prover -- trust-compose vkey`).
    /// @param programVKey The same composition guest vkey, passed explicitly so the factory
    ///        constructor can cross-check it against the verifier. If zero, falls back to the
    ///        `SP1_COMPOSITION_PROGRAM_VKEY` env var.
    /// @param instanceRegistryAddr The chain's `InstanceRegistry`.
    /// @param epochFloor Minimum epoch length in blocks (mainnet: ~30 days; anvil: small).
    /// @param policyActivationDelay Seconds between `proposePolicy` and the earliest
    ///        `activatePolicy`. IMMUTABLE on the factory and copied into every controller it
    ///        deploys — the review window in which operators re-verify a proposed policy's bytes.
    /// @param provingVaultAddr The chain's `ProvingVault`, or "" for none. Empty falls back to the
    ///        `PROVING_VAULT` environment variable, and zero disables the prepay path — a factory
    ///        with no vault reverts on any `msg.value` rather than silently keeping it. IMMUTABLE.
    /// @return factory The deployed `TrustComposeFactory`.
    function run(
        string calldata zkVerifierAddr,
        bytes32 programVKey,
        string calldata instanceRegistryAddr,
        uint64 epochFloor,
        uint48 policyActivationDelay,
        string memory provingVaultAddr
    ) public returns (address factory) {
        address zkVerifier = vm.parseAddress(zkVerifierAddr);
        address instanceRegistry = vm.parseAddress(instanceRegistryAddr);

        require(zkVerifier != address(0), "DeployTrustComposeFactory: zkVerifier is zero");
        require(instanceRegistry != address(0), "DeployTrustComposeFactory: instanceRegistry is zero");
        require(epochFloor > 0, "DeployTrustComposeFactory: epochFloor is zero");
        // Same fail-closed floor as `DeployFactory`: the floor is IMMUTABLE and bounds hosted
        // proving cost per instance, so the 1-block dev default must not reach a real chain.
        require(
            block.chainid == 31337 || epochFloor >= 7200,
            "DeployTrustComposeFactory: epochFloor too low for a non-dev chain (>= ~1 day of blocks)"
        );
        require(policyActivationDelay > 0, "DeployTrustComposeFactory: policyActivationDelay is zero");
        // The delay is the runbook's operator review window (research/operations/composition/runbook.md
        // "Rotate, cancel, roll back, or recover"). A seconds-long dev default reaching a real
        // chain would make policy rotation effectively instant, so anything under a day cannot be
        // deliberate off-devnet.
        require(
            block.chainid == 31337 || policyActivationDelay >= 1 days,
            "DeployTrustComposeFactory: policyActivationDelay too short for a non-dev chain (>= 1 day)"
        );

        // Program vkey: prefer the explicit param, else the env var. Never the trust-graph vkey —
        // the constructor cross-check below rejects a wrong value, but resolve it explicitly here
        // so the failure names the actual mistake.
        bytes32 vkey = programVKey == bytes32(0) ? vm.envBytes32("SP1_COMPOSITION_PROGRAM_VKEY") : programVKey;
        require(vkey != bytes32(0), "DeployTrustComposeFactory: programVKey is zero");

        // Zero disables the prepay path on this factory; `createInstance` then reverts on any
        // `msg.value` rather than silently keeping it.
        IProvingVault vault = IProvingVault(
            bytes(provingVaultAddr).length > 0
                ? vm.parseAddress(provingVaultAddr)
                : vm.envOr("PROVING_VAULT", address(0))
        );

        _startBroadcast();

        // The append-only registry of reviewed source adapters. The composition accumulator only
        // accepts adapters minted by THIS factory, so its address is part of the instance's trust
        // base and is recorded in the artifact below.
        CompositionSourceAdapterFactory sourceAdapterFactory =
            new CompositionSourceAdapterFactory(IInstanceRegistry(instanceRegistry));

        // The children whose creation code will not fit inside the factory (EIP-170).
        MerkleSnapshotDeployer snapshotDeployer = new MerkleSnapshotDeployer();
        MerkleFundDistributorDeployer distributorDeployer = new MerkleFundDistributorDeployer();
        CompositionSourceAccumulatorDeployer accumulatorDeployer = new CompositionSourceAccumulatorDeployer();
        TrustComposeParamsControllerDeployer paramsControllerDeployer = new TrustComposeParamsControllerDeployer();

        TrustComposeFactory composeFactory = new TrustComposeFactory(
            IZkVerifier(zkVerifier),
            vkey,
            IInstanceRegistry(instanceRegistry),
            ICompositionSourceAdapterFactory(address(sourceAdapterFactory)),
            snapshotDeployer,
            distributorDeployer,
            accumulatorDeployer,
            paramsControllerDeployer,
            epochFloor,
            policyActivationDelay,
            vault
        );
        factory = address(composeFactory);

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
                "DeployTrustComposeFactory: REGISTRAR_ROLE grant failed"
            );
            require(
                !registry.hasRole(registry.OPERATOR_ROLE(), factory),
                "DeployTrustComposeFactory: factory must not hold OPERATOR_ROLE"
            );
        }

        vm.stopBroadcast();

        console.log("ProvingVault:", address(vault), address(vault) == address(0) ? "(no prepay path)" : "");
        console.log("CompositionSourceAdapterFactory:", address(sourceAdapterFactory));
        console.log("MerkleSnapshotDeployer:", address(snapshotDeployer));
        console.log("MerkleFundDistributorDeployer:", address(distributorDeployer));
        console.log("CompositionSourceAccumulatorDeployer:", address(accumulatorDeployer));
        console.log("TrustComposeParamsControllerDeployer:", address(paramsControllerDeployer));
        console.log("TrustComposeFactory:", factory);
        console.log("programVKey:", vm.toString(vkey));
        console.log("epochFloor (blocks):", epochFloor);
        console.log("policyActivationDelay (seconds):", policyActivationDelay);

        string memory _json = "json";
        _json.serialize("instance_registry", Strings.toChecksumHexString(instanceRegistry));
        _json.serialize("zk_verifier", Strings.toChecksumHexString(zkVerifier));
        _json.serialize("program_vkey", vm.toString(vkey));
        _json.serialize("source_adapter_factory", Strings.toChecksumHexString(address(sourceAdapterFactory)));
        _json.serialize("snapshot_deployer", Strings.toChecksumHexString(address(snapshotDeployer)));
        _json.serialize("distributor_deployer", Strings.toChecksumHexString(address(distributorDeployer)));
        _json.serialize("accumulator_deployer", Strings.toChecksumHexString(address(accumulatorDeployer)));
        _json.serialize("params_controller_deployer", Strings.toChecksumHexString(address(paramsControllerDeployer)));
        _json.serialize("epoch_floor", uint256(epochFloor));
        _json.serialize("policy_activation_delay_seconds", uint256(policyActivationDelay));
        string memory finalJson = _json.serialize("trust_compose_factory", Strings.toChecksumHexString(factory));
        vm.writeFile(string.concat(root, "/.docker/trust_compose_factory_deploy.json"), finalJson);
    }
}
