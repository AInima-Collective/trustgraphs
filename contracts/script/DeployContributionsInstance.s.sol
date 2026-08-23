// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";

import {ISP1Verifier} from "interfaces/merkle/ISP1Verifier.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IAnchorRegistry} from "interfaces/registry/IAnchorRegistry.sol";
import {SP1JournalVerifier} from "src/merkle/SP1JournalVerifier.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {TrustAccumulatorMirror} from "src/merkle/TrustAccumulatorMirror.sol";
import {ContributionResolver} from "src/eas/resolvers/ContributionResolver.sol";
import {SchemaRegistrar} from "src/eas/SchemaRegistrar.sol";
import {TestUSDC} from "src/tokens/TestUSDC.sol";
import {ContributionsParamsCodec} from "src/params/ContributionsParamsCodec.sol";
import {ContributionsParamsController} from "src/factory/ContributionsParamsController.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

import {MockSP1Gateway} from "../test/mocks/MockSP1Gateway.sol";

import {Common} from "script/Common.s.sol";
import {ContributionsParamsJson} from "script/lib/ContributionsParamsJson.sol";

/// @title DeployContributionsInstance
/// @notice One labeled script for the WHOLE contributions instance battery
///         (docs/build/contributions/interfaces.md): ContributionResolver → the three schema
///         registrations (exact IF §1 strings) → one-shot `setSchemas` allowlist →
///         TrustAccumulatorMirror over the trust instance's accumulator →
///         SP1JournalVerifier (contributions vkey) → MerkleSnapshot (journal v2: slot A =
///         trust via the mirror, slot B = the resolver's own accumulator read as
///         IAnchorRegistry) → MerkleFundDistributor → TestUSDC pool token. `paramsHash` is
///         computed on-chain from the contributions params file + the freshly registered
///         schema UIDs (slots 19–21), then the UIDs are written back into the file so the
///         prover stays in sync — the DeployNetwork pattern.
///
/// Env: CONTRIBUTIONS_PROGRAM_VKEY (the contributions guest image id; bytes32(0) = dev
///      scaffolding, which deploys a MockSP1Gateway so mock-proved journals submit —
///      set the real vkey AND a real gateway for any deploy that matters),
///      SP1_VERIFIER_GATEWAY (canonical per-chain gateway; only read when a vkey is set
///      and no gateway address is passed),
///      CONTRIBUTIONS_EPOCH_LENGTH (blocks between triggers; default 10 for dev),
///      CONTRIBUTIONS_POOL_MINT (TestUSDC minted to the deployer; default 1,000,000 tUSDC),
///      CONSTITUTIONAL_ADMIN / OPERATIONAL_ADMIN (default: deployer).
contract DeployContributionsInstance is Common {
    using stdJson for string;

    string public root = vm.projectRoot();

    /// The three schema strings, EXACTLY as frozen in docs/build/contributions/interfaces.md §1
    /// (canonical registered form is comma-separated without spaces, the house schema-string
    /// format the config field parser consumes).
    string constant CLAIM_SCHEMA = "string title,bytes32 contentHash,string uri,address[] contributors,uint32[] shares";
    string constant RESPONSE_SCHEMA = "bytes32 claimUID,uint8 response";
    string constant VALUATION_SCHEMA = "bytes32 claimUID,uint8 score";

    /// @param outLabel Output-file discriminator: `.docker/contributions_instance_<outLabel>_deploy.json`.
    /// @param easAddr The existing EAS contract.
    /// @param schemaRegistrarAddr The existing SchemaRegistrar.
    /// @param trustAccumulatorAddr The TRUST instance's accumulator (its EASIndexerResolver) that
    ///        the mirror wraps for journal slot A.
    /// @param paramsPath Path to the contributions params file (serialized
    ///        `contributions_core::Params`; schema-UID fields are overwritten by this deploy).
    /// @param gatewayAddr The already-deployed SP1 verifier gateway (the DeployZkVerifier
    ///        convention). If empty, falls back to the `SP1_VERIFIER_GATEWAY` env var. Dev callers
    ///        MUST pass the local MockSP1Gateway here: the env var names Succinct's per-chain
    ///        deployment, which has no code on a plain anvil, and a verifier constructed over it
    ///        reverts every `submitProof` inside `gateway.verifyProof` — immutably.
    /// @param instanceRegistryAddr The chain's public instance directory. The broadcaster must
    ///        hold its OPERATOR_ROLE so this script can publish the new instance atomically.
    function run(
        string calldata outLabel,
        string calldata easAddr,
        string calldata schemaRegistrarAddr,
        string calldata trustAccumulatorAddr,
        string calldata paramsPath,
        string calldata gatewayAddr,
        string calldata instanceRegistryAddr
    ) public {
        address deployer = vm.addr(_privateKey);
        address eas = vm.parseAddress(easAddr);
        address schemaRegistrar = vm.parseAddress(schemaRegistrarAddr);
        address trustAccumulator = vm.parseAddress(trustAccumulatorAddr);
        IInstanceRegistry instanceRegistry = IInstanceRegistry(vm.parseAddress(instanceRegistryAddr));
        require(eas != address(0), "DeployContributionsInstance: eas is zero");
        require(schemaRegistrar != address(0), "DeployContributionsInstance: schemaRegistrar is zero");
        require(trustAccumulator != address(0), "DeployContributionsInstance: trustAccumulator is zero");
        require(address(instanceRegistry) != address(0), "DeployContributionsInstance: registry is zero");

        bytes32 vkey = vm.envOr("CONTRIBUTIONS_PROGRAM_VKEY", bytes32(0));
        uint64 epochLength = uint64(vm.envOr("CONTRIBUTIONS_EPOCH_LENGTH", uint256(10)));
        uint256 poolMint = vm.envOr("CONTRIBUTIONS_POOL_MINT", uint256(1_000_000e6));
        address constitutional = vm.envOr("CONSTITUTIONAL_ADMIN", deployer);
        address operational = vm.envOr("OPERATIONAL_ADMIN", deployer);

        _startBroadcast();

        // The resolver is deployed first: the three schema UIDs = f(schema string, resolver,
        // revocable) depend on its address, so registration (and the one-shot allowlist) must follow.
        ContributionResolver resolver = new ContributionResolver(IEAS(eas), deployer);

        bytes32 claimUid =
            SchemaRegistrar(schemaRegistrar).register(CLAIM_SCHEMA, ISchemaResolver(address(resolver)), true);
        bytes32 responseUid =
            SchemaRegistrar(schemaRegistrar).register(RESPONSE_SCHEMA, ISchemaResolver(address(resolver)), true);
        bytes32 valuationUid =
            SchemaRegistrar(schemaRegistrar).register(VALUATION_SCHEMA, ISchemaResolver(address(resolver)), true);
        resolver.setSchemas(claimUid, responseUid, valuationUid);

        // Slot-A seam: read-only mirror of the trust accumulator (never pushes checkpoints into it).
        TrustAccumulatorMirror mirror = new TrustAccumulatorMirror(IAttestationAccumulator(trustAccumulator));

        // Verifier: real gateway + contributions vkey when provided; otherwise dev scaffolding with a
        // MockSP1Gateway (accept-all at the SNARK seam) so `SP1_PROVER=mock` proofs submit locally.
        address gateway;
        if (vkey == bytes32(0)) {
            gateway = address(new MockSP1Gateway());
            console.log("CONTRIBUTIONS_PROGRAM_VKEY unset: dev MockSP1Gateway deployed at", gateway);
        } else {
            gateway =
                bytes(gatewayAddr).length == 0 ? vm.envAddress("SP1_VERIFIER_GATEWAY") : vm.parseAddress(gatewayAddr);
            require(gateway != address(0), "DeployContributionsInstance: gateway is zero");
        }
        SP1JournalVerifier verifier = new SP1JournalVerifier(ISP1Verifier(gateway), vkey);

        // paramsHash from the params file + the just-registered schema UIDs (slots 19-21).
        // `ContributionsParamsCodec.hash` is byte-identical to `contributions_core::params::params_hash`
        // (golden-tested), so the value the guest commits matches what MerkleSnapshot stores.
        ContributionsParamsCodec.Params memory params =
            ContributionsParamsJson.read(paramsPath, claimUid, responseUid, valuationUid);
        bytes32 paramsHash = ContributionsParamsCodec.hash(params);

        // Journal v2 wiring: slot A (acc, leafCount) = the trust accumulator via the mirror;
        // slot B (anchorAcc, anchorCount) = the contribution accumulator via the resolver's
        // IAnchorRegistry aliases. One trigger() freezes both lanes at the same block.
        MerkleSnapshot snapshot = new MerkleSnapshot(
            IZkVerifier(address(verifier)),
            paramsHash,
            IAttestationAccumulator(address(mirror)),
            // Deployer holds both roles during wiring; hand-off below.
            deployer,
            deployer
        );
        snapshot.setAnchorRegistry(IAnchorRegistry(address(resolver)));
        // M6-1: only the snapshot's trigger() may mint mirror checkpoints (a directly-minted id
        // would leave anchorCheckpoints[id] at (0,0) and admit a contributions-blind proof).
        mirror.bindSnapshot(address(snapshot));
        if (epochLength > 0) {
            snapshot.setEpochLength(epochLength);
        }

        // A unique public directory id, bound to both the label namespace and this snapshot.
        bytes32 instanceId = keccak256(abi.encode(deployer, "contributions", outLabel, address(snapshot)));
        ContributionsParamsController paramsController = new ContributionsParamsController(
            instanceId, address(snapshot), eas, instanceRegistry, params, operational, deployer
        );
        snapshot.grantRole(snapshot.OPERATIONAL_ROLE(), address(paramsController));
        snapshot.renounceRole(snapshot.OPERATIONAL_ROLE(), deployer);
        if (constitutional != deployer) {
            snapshot.grantRole(snapshot.CONSTITUTIONAL_ROLE(), constitutional);
            snapshot.renounceRole(snapshot.CONSTITUTIONAL_ROLE(), deployer);
        }

        MerkleFundDistributor distributor = new MerkleFundDistributor(
            deployer, // owner
            address(snapshot), // merkle snapshot
            deployer, // fee recipient
            3e16, // 3% fee (same as the trust instance's distributor)
            false // disable allowlist
        );

        // The dev funding pool token: 6-decimal test USDC, deployer pre-funded.
        TestUSDC poolToken = new TestUSDC();
        poolToken.mint(deployer, poolMint);

        // Register before publishing version 1. Streaming consumers learn the controller address
        // from ParamsAuthorityUpdated, then observe the complete tuple in the following log.
        instanceRegistry.registerWithParamsAuthority(
            instanceId,
            IInstanceRegistry.Instance({
                program: keccak256("contributions"),
                snapshot: address(snapshot),
                verifier: address(verifier),
                registryOrAccumulator: address(resolver),
                paramsHash: paramsHash
            }),
            address(paramsController)
        );
        paramsController.publishInitialVersion();

        vm.stopBroadcast();

        // Keep the prover's params file in sync with the registered schema UIDs (paramsHash already
        // used the registered values; the file's placeholders were ignored).
        vm.writeJson(vm.toString(claimUid), paramsPath, ".claim_schema_uid");
        vm.writeJson(vm.toString(responseUid), paramsPath, ".response_schema_uid");
        vm.writeJson(vm.toString(valuationUid), paramsPath, ".valuation_schema_uid");

        console.log("ContributionResolver:  ", address(resolver));
        console.log("TrustAccumulatorMirror:", address(mirror));
        console.log("SP1JournalVerifier:    ", address(verifier));
        console.log("MerkleSnapshot:        ", address(snapshot));
        console.log("MerkleFundDistributor: ", address(distributor));
        console.log("ParamsController:      ", address(paramsController));
        console.log("instanceId:            ", vm.toString(instanceId));
        console.log("TestUSDC:              ", address(poolToken));
        console.log("paramsHash:            ", vm.toString(paramsHash));

        // Persist for the deploy orchestration (contracts/deploy/env.ts merges this into the networks config,
        // which is what deployment_summary.json aggregates for the indexer + frontend).
        string memory contractsJson = "contracts";
        contractsJson.serialize("contribution_resolver", Strings.toChecksumHexString(address(resolver)));
        contractsJson.serialize("trust_accumulator_mirror", Strings.toChecksumHexString(address(mirror)));
        contractsJson.serialize("trust_accumulator", Strings.toChecksumHexString(trustAccumulator));
        contractsJson.serialize("sp1_gateway", Strings.toChecksumHexString(gateway));
        contractsJson.serialize("zk_verifier", Strings.toChecksumHexString(address(verifier)));
        contractsJson.serialize("merkle_snapshot", Strings.toChecksumHexString(address(snapshot)));
        contractsJson.serialize("params_controller", Strings.toChecksumHexString(address(paramsController)));
        contractsJson.serialize("instance_registry", Strings.toChecksumHexString(address(instanceRegistry)));
        contractsJson.serialize("fund_distributor", Strings.toChecksumHexString(address(distributor)));
        string memory finalContractsJson =
            contractsJson.serialize("pool_token", Strings.toChecksumHexString(address(poolToken)));

        string memory schemasJson = "schemas";
        schemasJson.serialize(
            "claim",
            _schemaJson(
                "claim",
                "contribution-claim",
                "Contribution",
                "A claimed contribution",
                CLAIM_SCHEMA,
                address(resolver),
                claimUid
            )
        );
        schemasJson.serialize(
            "response",
            _schemaJson(
                "response",
                "contribution-response",
                "Response",
                "Accept or reject being named on a contribution",
                RESPONSE_SCHEMA,
                address(resolver),
                responseUid
            )
        );
        string memory finalSchemasJson = schemasJson.serialize(
            "valuation",
            _schemaJson(
                "valuation",
                "contribution-valuation",
                "Valuation",
                "Score a contribution from 0 to 100",
                VALUATION_SCHEMA,
                address(resolver),
                valuationUid
            )
        );

        string memory _json = "json";
        _json.serialize("deployer", Strings.toChecksumHexString(deployer));
        _json.serialize("instance_id", vm.toString(instanceId));
        _json.serialize("params_hash", vm.toString(paramsHash));
        _json.serialize("epoch_length", uint256(epochLength));
        _json.serialize("contracts", finalContractsJson);
        string memory out = _json.serialize("schemas", finalSchemasJson);
        vm.writeFile(string.concat(root, "/.docker/contributions_instance_", outLabel, "_deploy.json"), out);
    }

    /// @dev Serialize one schema entry (the NetworkDeploy schema shape contracts/deploy/env.ts consumes).
    function _schemaJson(
        string memory objKey,
        string memory key,
        string memory name,
        string memory description,
        string memory schema,
        address resolverAddr,
        bytes32 uid
    ) internal returns (string memory) {
        string memory j = string.concat(objKey, "_schema_json");
        j.serialize("uid", vm.toString(uid));
        j.serialize("key", key);
        j.serialize("name", name);
        j.serialize("description", description);
        j.serialize("schema", schema);
        j.serialize("revocable", true);
        return j.serialize("resolver", Strings.toChecksumHexString(resolverAddr));
    }
}
