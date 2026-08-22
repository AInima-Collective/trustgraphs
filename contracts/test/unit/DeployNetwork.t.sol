// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";

import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";

import {DeployScript} from "script/DeployNetwork.s.sol";
import {SchemaRegistrar} from "src/eas/SchemaRegistrar.sol";
import {EASIndexerResolver} from "src/eas/resolvers/EASIndexerResolver.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {MockZkVerifier} from "../mocks/MockZkVerifier.sol";

contract DeployNetworkHarness is DeployScript {
    function deployNetworkForTest(
        address zkVerifier,
        string memory paramsPath,
        address eas,
        address schemaRegistrar,
        uint64 epochLength
    ) external returns (address resolver, address snapshot, bytes32 schemaUid) {
        NetworkDeployment memory deployed = _deployNetwork(
            zkVerifier, paramsPath, eas, schemaRegistrar, false, epochLength, address(this)
        );
        return (address(deployed.resolver), address(deployed.snapshot), deployed.schemaUid);
    }
}

/// @notice Regression coverage for issue #29: the direct deployment path must create a scheduled
///         snapshot, not leave epochLength at MerkleSnapshot's unscheduled zero default.
contract DeployNetworkTest is Test {
    string internal constant PARAMS = "tests/e2e/params.template.json";
    uint64 internal constant EPOCH_LENGTH = 7_200;

    SchemaRegistry internal schemaRegistry;
    EAS internal eas;
    SchemaRegistrar internal registrar;
    MockZkVerifier internal verifier;
    DeployNetworkHarness internal deployer;

    function setUp() public {
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        registrar = new SchemaRegistrar(ISchemaRegistry(address(schemaRegistry)));
        verifier = new MockZkVerifier();
        deployer = new DeployNetworkHarness();
    }

    function test_DeploySetsAndEnforcesEpochSchedule() public {
        (address resolverAddr, address snapshotAddr, bytes32 schemaUid) =
            deployer.deployNetworkForTest(address(verifier), PARAMS, address(eas), address(registrar), EPOCH_LENGTH);

        MerkleSnapshot snapshot = MerkleSnapshot(snapshotAddr);
        EASIndexerResolver resolver = EASIndexerResolver(payable(resolverAddr));

        assertEq(snapshot.epochLength(), EPOCH_LENGTH, "deployment must set the requested schedule");
        assertEq(address(snapshot.accumulator()), resolverAddr, "snapshot must read the deployed resolver");
        assertEq(resolver.boundSchema(), schemaUid, "resolver must be bound to its own schema");
        assertEq(resolver.snapshot(), snapshotAddr, "resolver must be bound to its snapshot");

        vm.expectRevert(
            abi.encodeWithSelector(MerkleSnapshot.EpochNotElapsed.selector, snapshot.epochOriginBlock(), EPOCH_LENGTH)
        );
        snapshot.trigger();
    }

    function test_DeployRejectsUnscheduledNetwork() public {
        vm.expectRevert(bytes("DeployNetwork: epoch length is zero"));
        deployer.deployNetworkForTest(address(verifier), PARAMS, address(eas), address(registrar), 0);
    }
}
