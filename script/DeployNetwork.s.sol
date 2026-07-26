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
     */
    function run(
        string calldata zkVerifierAddr,
        string calldata paramsPath,
        string calldata easAddr,
        string calldata schemaRegistrarAddr,
        bool deployFundDistributor,
        string calldata env,
        uint256 firstIndex,
        uint256 count
    ) public {
        address zkVerifier = vm.parseAddress(zkVerifierAddr);
        address eas = vm.parseAddress(easAddr);
        address schemaRegistrar = vm.parseAddress(schemaRegistrarAddr);

        require(zkVerifier != address(0), "DeployNetwork: zkVerifier is zero");
        require(eas != address(0), "DeployNetwork: eas is zero");
        require(schemaRegistrar != address(0), "DeployNetwork: schemaRegistrar is zero");

        vm.startBroadcast(_privateKey);

        for (uint256 i = firstIndex; i < firstIndex + count; i++) {
            string memory scriptOutputPath =
                string.concat(root, "/config/network_deploy_", env, "_", Strings.toString(i), ".json");

            string memory _contractsJson = string.concat("contracts", Strings.toString(i));
            string memory _schemasJson = string.concat("schemas", Strings.toString(i));

            address deployer = vm.addr(_privateKey);

            // Deploy the indexer resolver first: it IS the attestation accumulator that produces the
            // checkpoints MerkleSnapshot consumes.
            EASIndexerResolver indexerResolver = new EASIndexerResolver(IEAS(eas));
            _contractsJson.serialize("eas_indexer_resolver", Strings.toChecksumHexString(address(indexerResolver)));

            // Register the vouching schema BEFORE the snapshot. Its UID = getUID(schema, resolver,
            // revocable) is bound into `paramsHash`, so it must exist first. The dependency chain
            // resolver -> schemaUid -> paramsHash -> MerkleSnapshot is a clean DAG; the old two-phase
            // "deploy, read uid, recompute hash, redeploy" dance only existed because the hash used to be
            // supplied from outside before this schema was registered.
            bytes32 schemaUid = createSchema(
                _schemasJson,
                i,
                schemaRegistrar,
                address(indexerResolver),
                "vouching",
                "Vouch",
                "Weighted endorsement",
                "string comment,uint256 confidence",
                true
            );

            // Compute the canonical paramsHash on-chain from the governance params + this schema UID +
            // this instance's domain separators (params-schema v2: the resolver that IS this instance's
            // accumulator, and the chain it lives on). `ParamsCodec.hash` is byte-identical to
            // `pagerank-core::encode::params_hash` (golden-tested), so the value the guest commits
            // matches what MerkleSnapshot stores — and no two instances share a hash.
            bytes32 paramsHash = ParamsCodec.hash(
                ParamsJson.read(paramsPath, schemaUid, address(indexerResolver), uint64(block.chainid))
            );

            // Create the merkle snapshot, gated by the ZK verifier and fed by the accumulator, bound to the
            // paramsHash just computed. Admin roles are the deployer at bootstrap; DeployTimelocks transfers
            // them to the timelocks. paramsHash thereafter is mutable only through the operational timelock.
            MerkleSnapshot merkleSnapshot = new MerkleSnapshot(
                IZkVerifier(zkVerifier),
                paramsHash,
                IAttestationAccumulator(address(indexerResolver)),
                deployer,
                deployer
            );

            // Create the distributor.
            if (deployFundDistributor) {
                MerkleFundDistributor merkleFundDistributor = new MerkleFundDistributor(
                    deployer, // owner
                    address(merkleSnapshot), // merkle snapshot
                    deployer, // fee recipient
                    3e16, // 3% fee
                    false // disable allowlist
                );

                _contractsJson.serialize(
                    "fund_distributor", Strings.toChecksumHexString(address(merkleFundDistributor))
                );
            }

            string memory finalContractsJson =
                _contractsJson.serialize("merkle_snapshot", Strings.toChecksumHexString(address(merkleSnapshot)));

            string memory finalSchemasJson = vm.serializeString(_schemasJson, "_", "_");

            string memory rootJson = string.concat("root", Strings.toString(i));
            rootJson.serialize("deployer", Strings.toChecksumHexString(deployer));
            rootJson.serialize("contracts", finalContractsJson);
            rootJson = rootJson.serialize("schemas", finalSchemasJson);

            vm.writeFile(scriptOutputPath, rootJson);

            // Keep the prover's params.json in sync: write the registered schema UID and this instance's
            // domain separators back into it so a single-network deploy needs zero manual edits.
            // `paramsHash` is unaffected (all three were supplied by this script, not read from the file).
            // Multi-network runs get their UID from each network_deploy_<env>_<i>.json instead (one
            // shared file can't hold N distinct instances) — and the input-exporter fills the separators
            // from the chain it is reading regardless, so the prover never depends on this write.
            if (count == 1) {
                vm.writeJson(vm.toString(schemaUid), paramsPath, ".schema_uid");
                vm.writeJson(vm.toString(address(indexerResolver)), paramsPath, ".accumulator");
                vm.writeJson(vm.toString(block.chainid), paramsPath, ".chain_id");
                console.log("params.json schema_uid synced ->", vm.toString(schemaUid));
                console.log("params.json accumulator synced ->", vm.toString(address(indexerResolver)));
            } else {
                console.log(
                    string.concat(
                        "network ",
                        Strings.toString(i),
                        " schema_uid (sync into its params.json): ",
                        vm.toString(schemaUid)
                    )
                );
            }
        }

        vm.stopBroadcast();
    }

    /// @notice Create a new schema
    function createSchema(
        string memory schemasJson,
        uint256 index,
        address schemaRegistrar,
        address resolverAddr,
        string memory key,
        string memory name,
        string memory description,
        string memory schema,
        bool revocable
    ) public returns (bytes32) {
        string memory newSchemaJson = string.concat(key, "_", Strings.toString(index), "_schema_json");

        bytes32 uid = SchemaRegistrar(schemaRegistrar).register(schema, ISchemaResolver(resolverAddr), revocable);
        console.log(key, "schema ID:", vm.toString(uid));

        newSchemaJson.serialize("uid", vm.toString(uid));
        newSchemaJson.serialize("key", key);
        newSchemaJson.serialize("name", name);
        newSchemaJson.serialize("description", description);
        newSchemaJson.serialize("schema", schema);
        vm.serializeBool(newSchemaJson, "revocable", revocable);
        newSchemaJson = newSchemaJson.serialize("resolver", Strings.toChecksumHexString(resolverAddr));

        // Add the new schema to the schemas JSON
        schemasJson.serialize(key, newSchemaJson);

        return uid;
    }
}
