// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {
    ISchemaRegistry,
    SchemaRegistry
} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {IEAS, EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {EASIndexerResolver} from "src/eas/resolvers/EASIndexerResolver.sol";
import {SchemaRegistrar} from "src/eas/SchemaRegistrar.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {ParamsCodec} from "src/params/ParamsCodec.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {ParamsJson} from "script/lib/ParamsJson.sol";

/// @notice Accept-all verifier for the always-on (off-chain) half of the e2e. The on-chain half
///         re-points the snapshot at a real `SP1JournalVerifier` through the constitutional knob
///         the deployer still holds, so nothing about the proof path is faked twice.
contract AcceptAllVerifier is IZkVerifier {
    function verify(bytes calldata, bytes32) external pure {}
}

/// @title DeployEasResolver
/// @notice The minimal deploy the input-exporter e2e needs: EAS + the `EASIndexerResolver` (which
///         is the AttestationAccumulator) + a `(string comment, uint256 confidence)` schema wired
///         to it + the `MerkleSnapshot` that owns its epochs.
/// @dev    The snapshot is no longer optional here. an unbound accumulator would let an exporter e2e freeze
///         inputs with one `cast send` and never deploy a snapshot at all. The accumulator is bound to exactly one snapshot and
///         only that snapshot's `trigger()` may mint — which is also what pins the checkpoint's
///         `paramsHash`, without which no proof can be submitted. So the e2e deploys the full
///         resolver → schema → paramsHash → snapshot → bind chain.
contract DeployEasResolver is Script {
    /// The e2e's governance params (`schema_uid` is patched in by the caller; the domain
    /// separators come from this deploy).
    string constant PARAMS_TEMPLATE = "tests/e2e/params.template.json";

    function run() external {
        vm.startBroadcast();

        SchemaRegistry registry = new SchemaRegistry();
        EAS eas = new EAS(ISchemaRegistry(address(registry)));
        EASIndexerResolver resolver = new EASIndexerResolver(IEAS(address(eas)));
        SchemaRegistrar registrar = new SchemaRegistrar(ISchemaRegistry(address(registry)));
        // Schema shape matches params.weight_field_index = 1 (confidence in ABI head slot 1).
        bytes32 schemaUid =
            registrar.register("string comment,uint256 confidence", ISchemaResolver(address(resolver)), true);

        // resolver -> schemaUid -> paramsHash -> snapshot -> bind. The same DAG the factory walks
        // inside one transaction; here it is one script run.
        bytes32 paramsHash =
            ParamsCodec.hash(ParamsJson.read(PARAMS_TEMPLATE, schemaUid, address(resolver), uint64(block.chainid)));

        AcceptAllVerifier verifier = new AcceptAllVerifier();
        MerkleSnapshot snapshot = new MerkleSnapshot(
            IZkVerifier(address(verifier)),
            paramsHash,
            IAttestationAccumulator(address(resolver)),
            msg.sender, // constitutional: the e2e re-points the verifier for the on-chain half
            msg.sender, // operational
            ""
        );

        resolver.bindSchema(schemaUid);
        resolver.bindSnapshot(address(snapshot));

        vm.stopBroadcast();

        string memory json = "e2e";
        vm.serializeAddress(json, "eas", address(eas));
        vm.serializeAddress(json, "resolver", address(resolver));
        vm.serializeAddress(json, "schema_registrar", address(registrar));
        vm.serializeAddress(json, "snapshot", address(snapshot));
        vm.serializeBytes32(json, "params_hash", paramsHash);
        string memory out = vm.serializeBytes32(json, "schema_uid", schemaUid);
        vm.writeFile("tests/e2e/deploy.json", out);

        console.log("EAS:      ", address(eas));
        console.log("RESOLVER: ", address(resolver));
        console.log("REGISTRAR:", address(registrar));
        console.log("SNAPSHOT: ", address(snapshot));
        console.log("SCHEMA_UID:");
        console.logBytes32(schemaUid);
        console.log("PARAMS_HASH:");
        console.logBytes32(paramsHash);
    }
}
