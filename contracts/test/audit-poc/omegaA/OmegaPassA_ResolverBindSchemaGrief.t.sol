// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";

import {EASIndexerResolver} from "src/eas/resolvers/EASIndexerResolver.sol";
import {SchemaRegistrar} from "src/eas/SchemaRegistrar.sol";

/// @notice PASS A PoC.
///
/// `EASIndexerResolver.bindSchema` is permissionless, one-shot, and accepts ANY non-zero bytes32:
///
///     function bindSchema(bytes32 schemaUid) external {
///         if (boundSchema != bytes32(0) || schemaUid == bytes32(0)) revert SchemaAlreadyBound();
///         boundSchema = schemaUid; ...
///     }
///
/// The doc comment justifies the missing gate with "the schema UID commits to this resolver's own
/// address ... so the caller cannot choose a UID that belongs to anyone else's instance". That is
/// true of REAL UIDs and irrelevant: nothing requires the argument to be a registered UID at all.
///
/// `TrustgraphsFactory` closes the window by binding in the same transaction. The two script
/// deploy paths do not — `DeployEasResolver.run` deploys the
/// resolver and bind it in separate broadcast transactions, so a watcher can bind garbage in
/// between and permanently brick the resolver (and, with it, the whole network being deployed:
/// `acc` is a chained hash with no rotation path once checkpoints exist).
contract OmegaPassA_ResolverBindSchemaGrief is Test {
    SchemaRegistry internal schemaRegistry;
    EAS internal eas;
    SchemaRegistrar internal registrar;

    address internal deployer = makeAddr("deployer");
    address internal griefer = makeAddr("griefer");

    function setUp() public {
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        registrar = new SchemaRegistrar(ISchemaRegistry(address(schemaRegistry)));
    }

    function test_PassA_StrangerBindsGarbageAndBricksTheResolverPermanently() public {
        // tx 1 of the deploy script: the resolver lands.
        vm.prank(deployer);
        EASIndexerResolver resolver = new EASIndexerResolver(IEAS(address(eas)));

        // The griefer front-runs tx 2/3 with an arbitrary, unregistered UID.
        vm.prank(griefer);
        resolver.bindSchema(keccak256("not-a-real-schema"));
        assertEq(resolver.boundSchema(), keccak256("not-a-real-schema"));

        // The deployer's own registration still succeeds...
        vm.prank(deployer);
        bytes32 realUid =
            registrar.register("string comment,uint256 confidence", ISchemaResolver(address(resolver)), true);

        // ...but the binding step now reverts, and there is no rebind path.
        vm.prank(deployer);
        vm.expectRevert(EASIndexerResolver.SchemaAlreadyBound.selector);
        resolver.bindSchema(realUid);

        // Every attestation against the real schema is rejected by the resolver, so the
        // accumulator can never fold a single edge.
        vm.expectRevert();
        eas.attest(
            AttestationRequest({
                schema: realUid,
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
        assertEq(resolver.leafCount(), 0, "resolver is inert forever");
    }
}
