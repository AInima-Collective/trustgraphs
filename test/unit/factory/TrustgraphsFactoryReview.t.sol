// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {NO_EXPIRATION_TIME, EMPTY_UID} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {SchemaRecord} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {TrustgraphsFactory} from "contracts/factory/TrustgraphsFactory.sol";
import {EASIndexerResolver} from "contracts/eas/resolvers/EASIndexerResolver.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {ParamsCodec} from "contracts/params/ParamsCodec.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

import {TrustgraphsFactoryBase} from "./TrustgraphsFactoryBase.sol";

/// @title TrustgraphsFactoryReviewTest
/// @notice Regression suite for the M6 security review. Every test here began as a working proof of
///         concept against the pre-fix code; each now asserts that the hole is closed. The attack
///         setup is kept verbatim on purpose — these are the exact transactions an attacker sends,
///         and they must keep failing, for the stated reason.
contract TrustgraphsFactoryReviewTest is TrustgraphsFactoryBase {
    address internal attacker = address(0xBAD);
    address internal member = address(0x11);
    address internal peer = address(0x22);

    /// @dev A vouch in the canonical schema: `string comment, uint256 confidence`.
    function _vouch(bytes32 schemaUid, address attester, address recipient, string memory comment, uint256 confidence)
        internal
        returns (bytes32 uid)
    {
        vm.prank(attester);
        uid = eas.attest(
            AttestationRequest({
                schema: schemaUid,
                data: AttestationRequestData({
                    recipient: recipient,
                    expirationTime: NO_EXPIRATION_TIME,
                    revocable: true,
                    refUID: EMPTY_UID,
                    data: abi.encode(comment, confidence),
                    value: 0
                })
            })
        );
    }

    /*//////////////////////////////////////////////////////////////
      F1 — SCHEMA SQUATTING MUST NOT BRICK THE FACTORY
    //////////////////////////////////////////////////////////////*/

    /// `createInstance` deploys `new EASIndexerResolver(EAS)` with CREATE, so the resolver's address
    /// is `keccak(rlp(factory, factoryNonce))[12:]` — public knowledge. EAS's `SchemaRegistry`
    /// (a) keys a schema by `keccak256(abi.encodePacked(schema, resolver, revocable))` with no
    /// `msg.sender`, (b) does not require the resolver to have code, and (c) reverts `AlreadyExists`
    /// on a duplicate.
    ///
    /// So anyone could pre-register the exact tuple the factory was about to use. Because the
    /// creation then reverted, the factory's own nonce was rolled back with it and the SAME address
    /// was predicted next time: one ~100k-gas transaction from any address bricked `createInstance`
    /// for every creator, forever, with no recovery path.
    ///
    /// The factory now ADOPTS an existing UID rather than insisting on registering it. That is safe
    /// by construction — the UID is a pure hash of the tuple, so a UID that already exists for this
    /// freshly-created resolver can only be the canonical schema, revocable, bound to it.
    function test_F1_SchemaSquattingIsAbsorbed() public {
        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));

        vm.prank(attacker);
        bytes32 squatted = schemaRegistry.register(factory.VOUCH_SCHEMA(), ISchemaResolver(predicted), true);

        Created memory c = _create(_args("squatted"));

        assertEq(c.resolver, predicted, "the resolver is the address the attacker targeted");
        assertEq(c.schemaUid, squatted, "the instance adopted the pre-registered UID");
        assertTrue(registry.isRegistered(c.instanceId), "the instance is in the directory");

        // ...and the adopted record is exactly the one the factory would have written itself.
        SchemaRecord memory rec = schemaRegistry.getSchema(squatted);
        assertEq(address(rec.resolver), c.resolver, "resolver");
        assertEq(rec.schema, factory.VOUCH_SCHEMA(), "schema string");
        assertTrue(rec.revocable, "revocable");

        // The instance is fully functional: the adopted schema really does route to its accumulator.
        _vouch(c.schemaUid, member, peer, "works", 50);
        assertEq(IAttestationAccumulator(c.resolver).leafCount(), 1, "the vouch folded");
    }

    /// Nor is the factory brickable by repetition: a squatter who front-runs every creation is only
    /// pre-paying for schemas the factory happily adopts.
    function test_F1_RepeatedSquattingNeverStopsCreation() public {
        for (uint256 i = 0; i < 3; i++) {
            address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
            vm.prank(attacker);
            schemaRegistry.register(factory.VOUCH_SCHEMA(), ISchemaResolver(predicted), true);
            _create(_args(string(abi.encodePacked("squatted-", vm.toString(i)))));
        }
        assertEq(registry.instanceCount(), 3, "every creation went through");
    }

    /*//////////////////////////////////////////////////////////////
      F2 — A FOREIGN SCHEMA MUST NOT POISON AN INSTANCE
    //////////////////////////////////////////////////////////////*/

    /// The EAS binding is one-way: a schema names its resolver, a resolver does not name its
    /// schema. `EASIndexerResolver.onAttest` therefore used to fold EVERY attestation EAS routed to
    /// it, whatever schema it belonged to.
    ///
    /// That was fatal because the two halves of the proving pipeline disagree about which edges
    /// exist: the guest re-folds the FULL leaf list and asserts it reproduces the checkpointed
    /// `acc` (`compute.rs`), while `input-exporter` only collects candidates for the instance's own
    /// `schema_uid`. One foreign attestation therefore made an instance permanently unprovable —
    /// and `acc` is a chained hash, so every later checkpoint carried the poison. Any stranger, one
    /// attestation, no recovery short of a new resolver and the loss of all vouch history.
    ///
    /// The resolver is now bound to its schema at creation and refuses everything else.
    function test_F2_AForeignSchemaCannotReachAnInstancesAccumulator() public {
        Created memory c = _create(_args("victim"));
        _vouch(c.schemaUid, member, peer, "genuine", 50);
        uint64 leavesBefore = IAttestationAccumulator(c.resolver).leafCount();

        // Registering the foreign schema is still permitted — it is inert, which is the point.
        vm.prank(attacker);
        bytes32 foreign = schemaRegistry.register("string poison", ISchemaResolver(c.resolver), true);

        vm.expectRevert(abi.encodeWithSelector(EASIndexerResolver.ForeignSchema.selector, foreign, c.schemaUid));
        _vouch(foreign, attacker, attacker, "poison", 1);

        assertEq(
            IAttestationAccumulator(c.resolver).leafCount(), leavesBefore, "no foreign edge may enter the accumulator"
        );
    }

    /// The binding is one-shot and set during creation, so there is no window in which an instance
    /// accepts foreign edges, and nobody can re-point a live instance at another schema.
    function test_F2_TheSchemaBindingIsSetAtCreationAndImmutable() public {
        Created memory c = _create(_args("bound"));
        assertEq(EASIndexerResolver(payable(c.resolver)).boundSchema(), c.schemaUid, "bound at creation");

        vm.prank(attacker);
        vm.expectRevert(EASIndexerResolver.SchemaAlreadyBound.selector);
        EASIndexerResolver(payable(c.resolver)).bindSchema(bytes32(uint256(0xdead)));
    }

    /// One instance's attestations land only on its own accumulator, in both directions — the
    /// second resolver here is bound to its own schema and folds its own edge, while the victim's
    /// count never moves.
    function test_F2_EachInstanceFoldsOnlyItsOwnEdges() public {
        Created memory c = _create(_args("victim-isolated"));

        EASIndexerResolver other = new EASIndexerResolver(eas);
        vm.prank(attacker);
        bytes32 otherSchema = schemaRegistry.register(factory.VOUCH_SCHEMA(), ISchemaResolver(address(other)), true);
        other.bindSchema(otherSchema);
        _vouch(otherSchema, attacker, peer, "elsewhere", 10);

        assertEq(IAttestationAccumulator(c.resolver).leafCount(), 0, "victim untouched");
        assertEq(IAttestationAccumulator(address(other)).leafCount(), 1, "landed on its own");
    }

    /*//////////////////////////////////////////////////////////////
      F4 — REGISTER AND UPDATE ARE DIFFERENT PRIVILEGES
    //////////////////////////////////////////////////////////////*/

    /// `register` and `update` used to share one `OPERATOR_ROLE`, so granting the factory the
    /// ability to append a directory row also granted it the ability to re-point ANY existing
    /// instance's record — snapshot and verifier included — at addresses of its choosing. Five
    /// places in the codebase claimed the opposite. The roles are now split.
    function test_F4_TheFactoryCanAppendButNotRewrite() public {
        Created memory c = _create(_args("directory-row"));

        IInstanceRegistry.Instance memory hijack = IInstanceRegistry.Instance({
            program: factory.PROGRAM(),
            snapshot: address(0xdead),
            verifier: address(0xdead),
            registryOrAccumulator: address(0xdead),
            paramsHash: bytes32(uint256(0xdead))
        });

        bytes32 operatorRole = registry.OPERATOR_ROLE();
        vm.prank(address(factory));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(factory), operatorRole
            )
        );
        registry.update(c.instanceId, hijack);

        assertEq(registry.getInstance(c.instanceId).snapshot, c.snapshot, "row untouched");
        assertTrue(
            registry.hasRole(registry.REGISTRAR_ROLE(), address(factory)), "the factory keeps the privilege it needs"
        );
    }

    /*//////////////////////////////////////////////////////////////
      F10 — THE DEPLOYER SINGLETONS ARE PERMISSIONLESS BY DESIGN
    //////////////////////////////////////////////////////////////*/

    /// Anyone may call `MerkleSnapshotDeployer.deploy` and name the factory as constitutional
    /// admin. ACCEPTED, NOT FIXED, and recorded here so the next reader does not mistake it for an
    /// oversight: the product is an unregistered contract that no directory lists, no prover proves
    /// and no UI shows. It does mean "the factory holds zero roles anywhere" is false as a literal
    /// statement. The true invariant, and the one the suite enforces, is that the factory holds
    /// nothing on any instance IT created.
    function test_F10_AnyoneCanMintAnUnregisteredSnapshotNamingTheFactory() public {
        vm.prank(attacker);
        MerkleSnapshot rogue = snapshotDeployer.deploy(
            verifier, bytes32(uint256(1)), IAttestationAccumulator(address(0xACC)), address(factory), attacker
        );

        assertTrue(rogue.hasRole(rogue.CONSTITUTIONAL_ROLE(), address(factory)), "as constructed");
        assertEq(registry.instanceCount(), 0, "but it is in no directory");
    }
}
