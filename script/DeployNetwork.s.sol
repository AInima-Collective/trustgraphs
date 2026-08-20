// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";

import {Common} from "script/Common.s.sol";

import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {MerkleFundDistributor} from "contracts/merkle/MerkleFundDistributor.sol";
import {SchemaRegistrar} from "contracts/eas/SchemaRegistrar.sol";
import {EASIndexerResolver} from "contracts/eas/resolvers/EASIndexerResolver.sol";
import {ParamsCodec} from "contracts/params/ParamsCodec.sol";
import {ParamsJson} from "script/lib/ParamsJson.sol";

/// @dev Deployment script for network contracts
contract DeployScript is Common {
    using stdJson for string;

    string public root = vm.projectRoot();

    struct NetworkDeployment {
        EASIndexerResolver resolver;
        MerkleSnapshot snapshot;
        MerkleFundDistributor distributor;
        bytes32 schemaUid;
    }

    /**
     * @dev Deploys the contracts and writes the results to a JSON file.
     * @param zkVerifierAddr The address of the ZK proof verifier gating root updates
     * @param paramsPath Path to the governance `params.json` (serialized `pagerank_core::Params`) — the
     *        same file the prover feeds the guest. The canonical `paramsHash` is computed FROM it in
     *        this script (after the schema is registered), so no precomputed hash is supplied. The
     *        file's `schema_uid` field is ignored; the freshly registered UID is used instead and, for
     *        a single-network deploy, written back into the file so the prover stays in sync.
     * @param easAddr The address of the EAS contract
     * @param schemaRegistrarAddr The address of the schema registrar contract
     * @param deployFundDistributor Whether to deploy the fund distributor contract
     * @param env The environment suffix for the deployment file name
     * @param firstIndex The index of the first network to deploy
     * @param count How many networks to deploy
     * @param epochLength Nonzero number of blocks between score checkpoints
     */
    function run(
        string calldata zkVerifierAddr,
        string calldata paramsPath,
        string calldata easAddr,
        string calldata schemaRegistrarAddr,
        bool deployFundDistributor,
        string calldata env,
        uint256 firstIndex,
        uint256 count,
        uint64 epochLength
    ) public {
        address zkVerifier = vm.parseAddress(zkVerifierAddr);
        address eas = vm.parseAddress(easAddr);
        address schemaRegistrar = vm.parseAddress(schemaRegistrarAddr);

        require(zkVerifier != address(0), "DeployNetwork: zkVerifier is zero");
        require(eas != address(0), "DeployNetwork: eas is zero");
        require(schemaRegistrar != address(0), "DeployNetwork: schemaRegistrar is zero");
        require(epochLength != 0, "DeployNetwork: epoch length is zero");

        vm.startBroadcast(_privateKey);

        for (uint256 i = firstIndex; i < firstIndex + count; i++) {
            string memory scriptOutputPath =
                string.concat(root, "/config/network_deploy_", env, "_", Strings.toString(i), ".json");

            string memory _contractsJson = string.concat("contracts", Strings.toString(i));
            string memory _schemasJson = string.concat("schemas", Strings.toString(i));

            address deployer = vm.addr(_privateKey);

            NetworkDeployment memory deployed = _deployNetwork(
                zkVerifier, paramsPath, eas, schemaRegistrar, deployFundDistributor, epochLength, deployer
            );

            _contractsJson.serialize("eas_indexer_resolver", Strings.toChecksumHexString(address(deployed.resolver)));
            _serializeSchema(_schemasJson, i, address(deployed.resolver), deployed.schemaUid);

            if (address(deployed.distributor) != address(0)) {
                _contractsJson.serialize("fund_distributor", Strings.toChecksumHexString(address(deployed.distributor)));
            }

            string memory finalContractsJson =
                _contractsJson.serialize("merkle_snapshot", Strings.toChecksumHexString(address(deployed.snapshot)));

            string memory finalSchemasJson = vm.serializeString(_schemasJson, "_", "_");

            string memory rootJson = string.concat("root", Strings.toString(i));
            rootJson.serialize("deployer", Strings.toChecksumHexString(deployer));
            rootJson.serialize("contracts", finalContractsJson);
            rootJson.serialize("epoch_length", uint256(epochLength));
            rootJson = rootJson.serialize("schemas", finalSchemasJson);

            vm.writeFile(scriptOutputPath, rootJson);

            // Keep the prover's params.json in sync: write the registered schema UID and this instance's
            // domain separators back into it so a single-network deploy needs zero manual edits.
            // `paramsHash` is unaffected (all three were supplied by this script, not read from the file).
            // Multi-network runs get their UID from each network_deploy_<env>_<i>.json instead (one
            // shared file can't hold N distinct instances) — and the input-exporter fills the separators
            // from the chain it is reading regardless, so the prover never depends on this write.
            if (count == 1) {
                vm.writeJson(vm.toString(deployed.schemaUid), paramsPath, ".schema_uid");
                vm.writeJson(vm.toString(address(deployed.resolver)), paramsPath, ".accumulator");
                vm.writeJson(vm.toString(block.chainid), paramsPath, ".chain_id");
                console.log("params.json schema_uid synced ->", vm.toString(deployed.schemaUid));
                console.log("params.json accumulator synced ->", vm.toString(address(deployed.resolver)));
            } else {
                console.log(
                    string.concat(
                        "network ",
                        Strings.toString(i),
                        " schema_uid (sync into its params.json): ",
                        vm.toString(deployed.schemaUid)
                    )
                );
            }
        }

        vm.stopBroadcast();
    }

    /// @dev Deploy one fully wired legacy network. Kept separate from file serialization so the
    ///      deployment invariants themselves can be exercised in Foundry tests.
    function _deployNetwork(
        address zkVerifier,
        string memory paramsPath,
        address eas,
        address schemaRegistrar,
        bool deployFundDistributor,
        uint64 epochLength,
        address deployer
    ) internal returns (NetworkDeployment memory deployed) {
        require(epochLength != 0, "DeployNetwork: epoch length is zero");

        // The resolver is the attestation accumulator whose checkpoints MerkleSnapshot consumes.
        deployed.resolver = new EASIndexerResolver(IEAS(eas));
        deployed.schemaUid = SchemaRegistrar(schemaRegistrar)
            .register("string comment,uint256 confidence", ISchemaResolver(address(deployed.resolver)), true);

        // The registered schema and instance domain are part of the canonical guest params.
        bytes32 paramsHash = ParamsCodec.hash(
            ParamsJson.read(paramsPath, deployed.schemaUid, address(deployed.resolver), uint64(block.chainid))
        );
        deployed.snapshot = new MerkleSnapshot(
            IZkVerifier(zkVerifier), paramsHash, IAttestationAccumulator(address(deployed.resolver)), deployer, deployer
        );

        // Enable the accepted-state provenance history now, while zero states exist — the only
        // moment it is possible (the window closes forever at the first accepted root). Without
        // it the network can never serve as a composition source; recording is additive and
        // never blocks acceptance.
        deployed.snapshot.enableStateProvenance();

        // A direct deployment must never leave the lane unscheduled: otherwise whoever proves
        // first chooses epoch boundaries and multiple settled states may share one block.
        deployed.snapshot.setEpochLength(epochLength);

        deployed.resolver.bindSchema(deployed.schemaUid);
        deployed.resolver.bindSnapshot(address(deployed.snapshot));

        if (deployFundDistributor) {
            deployed.distributor = new MerkleFundDistributor(
                deployer, // owner
                address(deployed.snapshot), // merkle snapshot
                deployer, // fee recipient
                3e16, // 3% fee
                false // disable allowlist
            );
        }
    }

    function _serializeSchema(string memory schemasJson, uint256 index, address resolverAddr, bytes32 uid) internal {
        string memory newSchemaJson = string.concat("vouching_", Strings.toString(index), "_schema_json");

        console.log("vouching schema ID:", vm.toString(uid));

        newSchemaJson.serialize("uid", vm.toString(uid));
        vm.serializeString(newSchemaJson, "key", "vouching");
        vm.serializeString(newSchemaJson, "name", "Vouch");
        vm.serializeString(newSchemaJson, "description", "Weighted endorsement");
        vm.serializeString(newSchemaJson, "schema", "string comment,uint256 confidence");
        vm.serializeBool(newSchemaJson, "revocable", true);
        newSchemaJson = newSchemaJson.serialize("resolver", Strings.toChecksumHexString(resolverAddr));

        schemasJson.serialize("vouching", newSchemaJson);
    }
}
