// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

import {SchemaRegistrar} from "src/eas/SchemaRegistrar.sol";
import {ContributionsFactory} from "src/factory/ContributionsFactory.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {ContributionsParamsControllerDeployer} from "src/factory/ContributionsInstanceDeployers.sol";
import {MerkleSnapshotDeployer, MerkleFundDistributorDeployer} from "src/factory/InstanceDeployers.sol";
import {SP1JournalVerifier} from "src/merkle/SP1JournalVerifier.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {ISP1Verifier} from "interfaces/merkle/ISP1Verifier.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

import {Common} from "script/Common.s.sol";

/// @title DeployContributionsFactory
/// @notice Stands up the contributions ROUND factory: the shared contributions
///         `SP1JournalVerifier` (one per chain + program vkey), the
///         `ContributionsParamsControllerDeployer`, the `ContributionsFactory` itself, and the
///         `REGISTRAR_ROLE` grant that lets it register rounds into the chain's
///         `InstanceRegistry`:
///         rounds are created ON-CHAIN through `createInstance` by the parent network's authority,
///         with no params file, no per-instance verifier, and no TestUSDC scaffolding.
///
/// @dev Runs AFTER `DeployEAS`, `DeployInstanceRegistry` and `DeployFactory` — it reuses the base
///      factory's `MerkleSnapshotDeployer` / `MerkleFundDistributorDeployer` singletons (they are
///      program-agnostic creation-code holders). The registrar grant needs the registry's admin
///      key; once that has moved to the operational timelock the grant becomes a governance action
///      and this script's grant step is skipped (`GRANT_REGISTRAR=false`).
///
/// Env: CONTRIBUTIONS_PROGRAM_VKEY — the contributions guest image id. REQUIRED on any real
///      chain (the factory constructor refuses a zero vkey and cross-checks the verifier). On a
///      local devnet (chainid 31337) an unset vkey falls back to a nonzero dev placeholder so the
///      factory's cross-check machinery still runs; pair it with the MockSP1Gateway, which accepts
///      any vkey at the SNARK seam.
contract DeployContributionsFactory is Common {
    using stdJson for string;

    string public root = vm.projectRoot();

    /// @notice Deploy the contributions factory and wire it to the registry.
    /// @param easAddr The chain's EAS.
    /// @param schemaRegistrarAddr The shared schema registrar.
    /// @param sp1GatewayAddr The SP1 verifier gateway the shared contributions verifier wraps
    ///        (canonical per-chain gateway in production; the local MockSP1Gateway on dev). If
    ///        empty, falls back to the `SP1_VERIFIER_GATEWAY` env var.
    /// @param instanceRegistryAddr The chain's `InstanceRegistry`.
    /// @param snapshotDeployerAddr The existing `MerkleSnapshotDeployer` (from `DeployFactory`).
    /// @param distributorDeployerAddr The existing `MerkleFundDistributorDeployer`.
    /// @param epochFloor Minimum epoch length in blocks (mainnet: ~30 days; anvil: small).
    /// @return factory The deployed `ContributionsFactory`.
    function run(
        string calldata easAddr,
        string calldata schemaRegistrarAddr,
        string calldata sp1GatewayAddr,
        string calldata instanceRegistryAddr,
        string calldata snapshotDeployerAddr,
        string calldata distributorDeployerAddr,
        uint64 epochFloor
    ) public returns (address factory) {
        address eas = vm.parseAddress(easAddr);
        address schemaRegistrar = vm.parseAddress(schemaRegistrarAddr);
        address instanceRegistry = vm.parseAddress(instanceRegistryAddr);
        address snapshotDeployer = vm.parseAddress(snapshotDeployerAddr);
        address distributorDeployer = vm.parseAddress(distributorDeployerAddr);

        address gateway =
            bytes(sp1GatewayAddr).length == 0 ? vm.envAddress("SP1_VERIFIER_GATEWAY") : vm.parseAddress(sp1GatewayAddr);
        return
            _deploy(eas, schemaRegistrar, gateway, instanceRegistry, snapshotDeployer, distributorDeployer, epochFloor);
    }

    /// @notice Public-chain continuation entry point. Reuses the child deployers exposed by the
    ///         already-deployed base factory, avoiding `.docker/factory_deploy.json` (which is
    ///         intentionally untrusted across local and public-chain runs).
    function run(
        string calldata easAddr,
        string calldata schemaRegistrarAddr,
        string calldata sp1GatewayAddr,
        string calldata instanceRegistryAddr,
        string calldata trustgraphsFactoryAddr,
        uint64 epochFloor
    ) public returns (address factory) {
        TrustgraphsFactory base = TrustgraphsFactory(vm.parseAddress(trustgraphsFactoryAddr));
        address gateway =
            bytes(sp1GatewayAddr).length == 0 ? vm.envAddress("SP1_VERIFIER_GATEWAY") : vm.parseAddress(sp1GatewayAddr);
        return _deploy(
            vm.parseAddress(easAddr),
            vm.parseAddress(schemaRegistrarAddr),
            gateway,
            vm.parseAddress(instanceRegistryAddr),
            address(base.SNAPSHOT_DEPLOYER()),
            address(base.DISTRIBUTOR_DEPLOYER()),
            epochFloor
        );
    }

    function _deploy(
        address eas,
        address schemaRegistrar,
        address gateway,
        address instanceRegistry,
        address snapshotDeployer,
        address distributorDeployer,
        uint64 epochFloor
    ) internal returns (address factory) {
        require(eas != address(0), "DeployContributionsFactory: eas is zero");
        require(schemaRegistrar != address(0), "DeployContributionsFactory: schemaRegistrar is zero");
        require(instanceRegistry != address(0), "DeployContributionsFactory: instanceRegistry is zero");
        require(snapshotDeployer != address(0), "DeployContributionsFactory: snapshotDeployer is zero");
        require(distributorDeployer != address(0), "DeployContributionsFactory: distributorDeployer is zero");
        require(epochFloor > 0, "DeployContributionsFactory: epochFloor is zero");
        // Same dev-default guard as DeployFactory: the floor bounds hosted proving cost and is
        // immutable, so a one-block dev default must never reach a real chain.
        require(
            block.chainid == 31337 || epochFloor >= 7200,
            "DeployContributionsFactory: epochFloor too low for a non-dev chain (>= ~1 day of blocks)"
        );

        require(gateway != address(0), "DeployContributionsFactory: gateway is zero");

        bytes32 vkey = vm.envOr("CONTRIBUTIONS_PROGRAM_VKEY", bytes32(0));
        if (vkey == bytes32(0)) {
            // The factory refuses a zero vkey by design. Local scaffolding gets a deterministic
            // nonzero placeholder (the MockSP1Gateway accepts any vkey); anywhere else, deploying
            // a factory whose verifier can never match the real guest would be a silent brick.
            require(
                block.chainid == 31337,
                "DeployContributionsFactory: CONTRIBUTIONS_PROGRAM_VKEY is required on a non-dev chain"
            );
            vkey = keccak256("trustgraphs/dev-contributions-vkey");
            console.log("CONTRIBUTIONS_PROGRAM_VKEY unset: using the dev placeholder vkey");
        }

        _startBroadcast();

        // One shared verifier per (chain, contributions vkey) — every round reuses it, exactly
        // like the trust-graph verifier. The factory constructor cross-checks its programVKey().
        SP1JournalVerifier verifier = new SP1JournalVerifier(ISP1Verifier(gateway), vkey);
        ContributionsParamsControllerDeployer paramsControllerDeployer = new ContributionsParamsControllerDeployer();

        ContributionsFactory contributionsFactory = new ContributionsFactory(
            IEAS(eas),
            SchemaRegistrar(schemaRegistrar),
            IZkVerifier(address(verifier)),
            vkey,
            IInstanceRegistry(instanceRegistry),
            MerkleSnapshotDeployer(snapshotDeployer),
            MerkleFundDistributorDeployer(distributorDeployer),
            paramsControllerDeployer,
            epochFloor
        );
        factory = address(contributionsFactory);

        // APPEND-only registry privilege, same argument as DeployFactory: REGISTRAR_ROLE lets the
        // factory add rows; it can never rewrite an existing community's record.
        if (vm.envOr("GRANT_REGISTRAR", true)) {
            InstanceRegistry registry = InstanceRegistry(instanceRegistry);
            registry.grantRole(registry.REGISTRAR_ROLE(), factory);
            require(
                registry.hasRole(registry.REGISTRAR_ROLE(), factory),
                "DeployContributionsFactory: REGISTRAR_ROLE grant failed"
            );
            require(
                !registry.hasRole(registry.OPERATOR_ROLE(), factory),
                "DeployContributionsFactory: factory must not hold OPERATOR_ROLE"
            );
        }

        vm.stopBroadcast();

        console.log("SP1 gateway:", gateway);
        console.log("Contributions vkey:", vm.toString(vkey));
        console.log("Contributions SP1JournalVerifier:", address(verifier));
        console.log("ContributionsParamsControllerDeployer:", address(paramsControllerDeployer));
        console.log("ContributionsFactory:", factory);
        console.log("epochFloor (blocks):", epochFloor);

        string memory _json = "json";
        _json.serialize("instance_registry", Strings.toChecksumHexString(instanceRegistry));
        _json.serialize("sp1_gateway", Strings.toChecksumHexString(gateway));
        _json.serialize("program_vkey", vm.toString(vkey));
        _json.serialize("zk_verifier", Strings.toChecksumHexString(address(verifier)));
        _json.serialize("snapshot_deployer", Strings.toChecksumHexString(snapshotDeployer));
        _json.serialize("distributor_deployer", Strings.toChecksumHexString(distributorDeployer));
        _json.serialize("params_controller_deployer", Strings.toChecksumHexString(address(paramsControllerDeployer)));
        _json.serialize("epoch_floor", uint256(epochFloor));
        string memory finalJson = _json.serialize("contributions_factory", Strings.toChecksumHexString(factory));
        vm.writeFile(string.concat(root, "/.docker/contributions_factory_deploy.json"), finalJson);
    }
}
