// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {SchemaRegistrar} from "contracts/eas/SchemaRegistrar.sol";
import {TrustgraphsFactory} from "contracts/factory/TrustgraphsFactory.sol";
import {TrustgraphsParamsController} from "contracts/factory/TrustgraphsParamsController.sol";
import {
    MerkleSnapshotDeployer,
    MerkleFundDistributorDeployer,
    TrustgraphsParamsControllerDeployer
} from "contracts/factory/InstanceDeployers.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {MerkleFundDistributor} from "contracts/merkle/MerkleFundDistributor.sol";
import {ParamsCodec} from "contracts/params/ParamsCodec.sol";
import {TrustgraphsParamsValidator} from "contracts/params/TrustgraphsParamsValidator.sol";
import {ITrustgraphsParamsController} from "interfaces/factory/ITrustgraphsParamsController.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";

import {
    CompositionSourceAdapter,
    CompositionSourceAdapterFactory
} from "contracts/composition/CompositionSourceAdapter.sol";

import {TrustgraphsFactoryBase} from "./TrustgraphsFactoryBase.sol";

/// @notice Adapter admission authenticates `programVKey()`, which the shared mock deliberately
///         lacks; this is the smallest verifier a composition source can be minted against.
contract ProgramKeyedVerifier is IZkVerifier {
    bytes32 public immutable programVKey;

    constructor(bytes32 programVKey_) {
        programVKey = programVKey_;
    }

    function verify(bytes calldata, bytes32) external pure {}
}

/// @title TrustgraphsFactoryTest
/// @notice M1's core battery: the properties that make one transaction a whole, safe instance —
///         the factory keeps nothing (ground rule 3), the `paramsHash` it computes is the golden
///         encoding, the event reconstructs the instance, the id cannot be squatted, and the epoch
///         floor is a raise rather than a rejection. Bounds live in `TrustgraphsFactoryBounds.t.sol`,
///         real-EAS wiring and domain separation in `TrustgraphsFactoryInstance.t.sol`.
contract TrustgraphsFactoryTest is TrustgraphsFactoryBase {
    using stdJson for string;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    /*//////////////////////////////////////////////////////////////
             GROUND RULE 3 — THE FACTORY KEEPS NOTHING, EVER
    //////////////////////////////////////////////////////////////*/

    /// One transaction produces a complete, self-consistent contract set: the snapshot reads the
    /// instance's own resolver as its accumulator, the shared verifier, and the hash the factory
    /// just computed. Nothing is left to a follow-up wiring transaction.
    function test_CreateWiresTheWholeInstance() public {
        Created memory c = _create(_args("basin"));

        assertTrue(c.snapshot != address(0), "snapshot");
        assertTrue(c.resolver != address(0), "resolver");
        assertTrue(c.schemaUid != bytes32(0), "schemaUid");
        assertEq(c.distributor, address(0), "no distributor was requested");

        MerkleSnapshot snapshot = MerkleSnapshot(c.snapshot);
        assertEq(address(snapshot.accumulator()), c.resolver, "snapshot must fold this resolver");
        assertEq(address(snapshot.zkVerifier()), address(verifier), "shared verifier");
        assertEq(address(snapshot.anchorRegistry()), address(0), "v1 instances are lane-1 only");
        assertEq(snapshot.epochLength(), EPOCH_FLOOR, "epoch schedule set in the same tx");
        assertTrue(
            snapshot.provenanceEnabled(),
            "the composition-source window must open at mint: no later actor can ever open it"
        );
    }

    /// The defect this guards against: no mint path enabled provenance, and nothing after creation
    /// can ever flip it (constitutional-only, pre-first-root-only), so no factory-minted network
    /// could ever be admitted as a composition source. A fresh mint must pass adapter admission
    /// with zero manual steps.
    function test_FreshMintIsAdmissibleAsCompositionSource() public {
        ProgramKeyedVerifier sourceVerifier = new ProgramKeyedVerifier(keccak256("source vkey"));
        TrustgraphsFactory sourceFactory = new TrustgraphsFactory(
            IEAS(address(eas)),
            registrar,
            IZkVerifier(address(sourceVerifier)),
            IInstanceRegistry(address(registry)),
            snapshotDeployer,
            distributorDeployer,
            paramsControllerDeployer,
            EPOCH_FLOOR,
            vault
        );
        bytes32 registrarRole = registry.REGISTRAR_ROLE();
        vm.prank(registryAdmin);
        registry.grantRole(registrarRole, address(sourceFactory));

        (bytes32 instanceId, address snapshot,,,) = sourceFactory.createInstance(_args("composable"));

        CompositionSourceAdapter adapter = new CompositionSourceAdapterFactory().create(
            IInstanceRegistry(address(registry)),
            instanceId,
            bytes32(uint256(1)),
            keccak256("weighted-allocation-v1"),
            keccak256("allocation"),
            keccak256("reviewed deployment packet")
        );
        assertEq(adapter.snapshot(), snapshot, "adapter pinned the minted snapshot");
        assertEq(adapter.programVKey(), keccak256("source vkey"), "adapter authenticated the program key");
    }

    /// GROUND RULE 3, no-distributor path: after `createInstance` returns, the factory holds no role
    /// on the new snapshot — enumerated over every role the transaction touched, not spot-checked —
    /// and the controller owned by the admin holds the operational role.
    function test_FactoryIsInertAfterCreate() public {
        Created memory c = _create(_args("inert"));
        _assertFactoryInert(c);
    }

    /// GROUND RULE 3, with-distributor path: the same, plus the distributor is owned outright by the
    /// admin with no pending handshake — the reason the constructor sets `owner` directly.
    function test_FactoryIsInertAfterCreateWithDistributor() public {
        TrustgraphsFactory.CreateArgs memory args = _args("inert-fund");
        args.withDistributor = true;
        args.distributorToken = address(0xDEC1);

        Created memory c = _create(args);
        assertTrue(c.distributor != address(0), "distributor must exist");
        _assertFactoryInert(c);
    }

    /// GROUND RULE 3 as a property rather than two examples: for ANY admin, salt and distributor
    /// choice, the factory ends the transaction holding nothing on the instance.
    function testFuzz_FactoryIsInertAfterCreate(address admin, bytes32 salt, bool withDistributor) public {
        // `address(factory)` is rejected outright — see test_FactoryRefusesToBeItsOwnAdmin.
        vm.assume(admin != address(factory));
        // The property distinguishes inherited creation authority from authority deliberately
        // assigned to the community admin. If those identities coincide, "deployer holds no role"
        // and "admin holds the constitutional role" cannot both be true as address-level claims.
        vm.assume(admin != address(snapshotDeployer));
        vm.assume(admin != address(distributorDeployer));
        vm.assume(admin != address(paramsControllerDeployer));

        TrustgraphsFactory.CreateArgs memory args = _args("fuzzed");
        args.admin = admin;
        args.salt = salt;
        args.withDistributor = withDistributor;

        Created memory c = _create(args);
        assertEq(c.admin, admin == address(0) ? address(this) : admin, "zero admin must mean msg.sender");
        _assertFactoryInert(c);
    }

    /// A zero `admin` is the wizard's "use my wallet": it resolves to `msg.sender`, not to nobody.
    function test_ZeroAdminDefaultsToTheCreator() public {
        TrustgraphsFactory.CreateArgs memory args = _args("default-admin");
        args.admin = address(0);
        args.withDistributor = true;

        vm.prank(alice);
        Created memory c = _create(args);

        assertEq(c.admin, alice, "admin defaults to the caller");
        assertEq(c.evt.creator, alice, "creator is the caller");
        assertEq(MerkleFundDistributor(payable(c.distributor)).owner(), alice);
        _assertFactoryInert(c);
    }

    /// The handover is functional, not nominal: the admin governs constitutional fields directly
    /// and scoring fields through the complete typed tuple, while raw hash mutation is unavailable.
    function test_AdminCanGovernAndFactoryCannot() public {
        Created memory c = _create(_args("handover"));
        MerkleSnapshot snapshot = MerkleSnapshot(c.snapshot);
        TrustgraphsParamsController controller = TrustgraphsParamsController(c.controller);
        ParamsCodec.Params memory next = controller.getCurrentParams();
        next.dampingFp -= 1;

        vm.prank(c.admin);
        snapshot.setEpochLength(EPOCH_FLOOR * 3); // constitutional
        vm.prank(c.admin);
        controller.updateParams(next, "ipfs://evidence"); // operational, typed and complete
        assertEq(snapshot.epochLength(), EPOCH_FLOOR * 3);
        assertEq(snapshot.paramsHash(), ParamsCodec.hash(next));
        assertEq(registry.getInstance(c.instanceId).paramsHash, ParamsCodec.hash(next));

        vm.prank(c.admin);
        vm.expectRevert();
        snapshot.setParamsHash(keccak256("raw-bypass"));

        bytes32 constitutional = snapshot.CONSTITUTIONAL_ROLE();
        vm.prank(address(factory));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(factory), constitutional
            )
        );
        snapshot.setEpochLength(1);
    }

    function test_ControllerPublishesCompleteVersionOne() public {
        Created memory c = _create(_args("version-one"));
        TrustgraphsParamsController controller = TrustgraphsParamsController(c.controller);
        ParamsCodec.Params memory current = controller.getCurrentParams();
        bytes32 liveHash = MerkleSnapshot(c.snapshot).paramsHash();

        assertEq(controller.version(), 1);
        assertEq(controller.currentParamsHash(), liveHash);
        assertEq(ParamsCodec.hash(current), liveHash);
        assertEq(current.schemaUid, c.schemaUid);
        assertEq(current.accumulator, c.resolver);
        assertEq(current.chainId, uint64(block.chainid));
        assertEq(current.trustedSeeds.length, c.evt.params.trustedSeeds.length);
        assertEq(registry.getInstance(c.instanceId).paramsHash, liveHash);
        assertEq(registry.paramsAuthority(c.instanceId), c.controller);
    }

    /// Streaming indexers learn the child address from the factory event. Version 1 must be
    /// published after that discovery log, not from the controller constructor where it would be
    /// permanently invisible to a dynamic source.
    function test_ControllerDiscoveryPrecedesVersionOnePublication() public {
        Created memory c = _create(_args("event-order"));
        uint256 discovery = type(uint256).max;
        uint256 publication = type(uint256).max;

        for (uint256 i = 0; i < c.logs.length; i++) {
            if (
                c.logs[i].emitter == address(factory) && c.logs[i].topics.length > 0
                    && c.logs[i].topics[0] == TrustgraphsFactory.ParamsControllerCreated.selector
            ) {
                discovery = i;
            }
            if (
                c.logs[i].emitter == c.controller && c.logs[i].topics.length > 0
                    && c.logs[i].topics[0] == ITrustgraphsParamsController.ParamsUpdated.selector
            ) {
                publication = i;
            }
        }

        assertTrue(discovery != type(uint256).max, "controller discovery missing");
        assertTrue(publication != type(uint256).max, "version one publication missing");
        assertLt(discovery, publication, "dynamic source must exist before version one log");
    }

    function test_RollbackPublishesANewVersionInsteadOfRewritingHistory() public {
        Created memory c = _create(_args("rollback"));
        TrustgraphsParamsController controller = TrustgraphsParamsController(c.controller);
        ParamsCodec.Params memory versionOne = controller.getCurrentParams();
        bytes32 versionOneHash = controller.currentParamsHash();

        ParamsCodec.Params memory versionTwo = controller.getCurrentParams();
        versionTwo.dampingFp -= 1;
        vm.prank(c.admin);
        controller.updateParams(versionTwo, "ipfs://version-two");
        assertEq(controller.version(), 2);

        vm.prank(c.admin);
        controller.updateParams(versionOne, "ipfs://rollback-rationale");
        assertEq(controller.version(), 3, "rollback is an append-only version");
        assertEq(controller.currentParamsHash(), versionOneHash);
        assertEq(MerkleSnapshot(c.snapshot).paramsHash(), versionOneHash);
        assertEq(registry.getInstance(c.instanceId).paramsHash, versionOneHash);
    }

    function test_ControllerRejectsNoopInvalidGrowthAndIdentityChanges() public {
        Created memory c = _create(_args("validation"));
        TrustgraphsParamsController controller = TrustgraphsParamsController(c.controller);
        ParamsCodec.Params memory next = controller.getCurrentParams();
        bytes32 beforeHash = controller.currentParamsHash();

        vm.prank(c.admin);
        vm.expectRevert(abi.encodeWithSelector(TrustgraphsParamsController.NoopUpdate.selector, beforeHash));
        controller.updateParams(next, "");

        next.dampingFp -= 1;
        vm.prank(alice);
        vm.expectRevert();
        controller.updateParams(next, "ipfs://unauthorized");

        next = controller.getCurrentParams();
        next.dampingFp = 9e17;
        next.trustMultiplierFp = 100e18;
        next.maxIterations = 500;
        vm.prank(c.admin);
        vm.expectRevert(
            abi.encodeWithSelector(TrustgraphsParamsValidator.RankGrowthUnbounded.selector, uint256(90e18), uint32(500))
        );
        controller.updateParams(next, "");

        next = controller.getCurrentParams();
        next.chainId += 1;
        vm.prank(c.admin);
        vm.expectRevert(TrustgraphsParamsValidator.IdentityFieldChanged.selector);
        controller.updateParams(next, "");

        assertEq(controller.version(), 1);
        assertEq(controller.currentParamsHash(), beforeHash);
        assertEq(MerkleSnapshot(c.snapshot).paramsHash(), beforeHash);
        assertEq(registry.getInstance(c.instanceId).paramsHash, beforeHash);
    }

    function test_ControllerUpdateIsAtomicWhenRegistryLegReverts() public {
        Created memory c = _create(_args("atomic"));
        TrustgraphsParamsController controller = TrustgraphsParamsController(c.controller);
        ParamsCodec.Params memory next = controller.getCurrentParams();
        next.dampingFp -= 1;
        bytes32 nextHash = ParamsCodec.hash(next);
        bytes32 beforeHash = controller.currentParamsHash();

        vm.mockCallRevert(
            address(registry),
            abi.encodeWithSelector(IInstanceRegistry.updateParamsHash.selector, c.instanceId, nextHash),
            abi.encodeWithSignature("Error(string)", "forced registry failure")
        );
        vm.prank(c.admin);
        vm.expectRevert(bytes("forced registry failure"));
        controller.updateParams(next, "ipfs://atomic");
        vm.clearMockedCalls();

        assertEq(controller.version(), 1);
        assertEq(controller.currentParamsHash(), beforeHash);
        assertEq(MerkleSnapshot(c.snapshot).paramsHash(), beforeHash, "snapshot write must roll back");
        assertEq(registry.getInstance(c.instanceId).paramsHash, beforeHash);
    }

    function test_ControllerOwnershipUsesTwoStepTransfer() public {
        Created memory c = _create(_args("two-step"));
        TrustgraphsParamsController controller = TrustgraphsParamsController(c.controller);
        address nextOwner = address(0xA770);

        vm.prank(c.admin);
        controller.transferOwnership(nextOwner);
        assertEq(controller.owner(), c.admin);
        assertEq(controller.pendingOwner(), nextOwner);

        vm.prank(alice);
        vm.expectRevert();
        controller.acceptOwnership();

        vm.prank(nextOwner);
        controller.acceptOwnership();
        assertEq(controller.owner(), nextOwner);
        assertEq(controller.pendingOwner(), address(0));
    }

    /// REFUTED counterexample, now a guard: naming the factory as admin used to leave it holding
    /// `OPERATIONAL_ROLE` and owning the distributor (ground rule 3 broken from public input), while
    /// the grant-then-renounce pair left the instance with no constitutional holder at all.
    function test_FactoryRefusesToBeItsOwnAdmin() public {
        TrustgraphsFactory.CreateArgs memory args = _args("self-admin");
        args.admin = address(factory);
        args.withDistributor = true;

        vm.expectRevert(TrustgraphsFactory.InvalidAdmin.selector);
        factory.createInstance(args);
    }

    /*//////////////////////////////////////////////////////////////
                       PARAMS HASH — GOLDEN PARITY
    //////////////////////////////////////////////////////////////*/

    /// PARITY ANCHOR (ground rule 2): the hash the factory stores in the new snapshot is exactly
    /// `ParamsCodec.hash` of the params it emitted, and that encoder reproduces
    /// `test/golden/trust-graph.json` — so the factory's own hash path cannot drift from the
    /// Rust/guest/TS legs. Proven in both directions: derived fields substituted into the golden
    /// struct must reproduce the STORED hash, and the golden derived fields substituted into the
    /// EMITTED struct must reproduce the golden VECTOR.
    function test_ParamsHashMatchesGoldenEncoder() public {
        Created memory c = _create(_args("golden"));
        bytes32 stored = MerkleSnapshot(c.snapshot).paramsHash();

        // Forward: golden params + this instance's identity == what is on chain.
        ParamsCodec.Params memory expected = _goldenParams();
        expected.schemaUid = c.schemaUid;
        expected.accumulator = c.resolver;
        expected.chainId = uint64(block.chainid);
        assertEq(stored, ParamsCodec.hash(expected), "factory hash must equal the codec's");

        // Backward: the emitted params, put back into the golden domain, must hash to the vector.
        // This is `TrustgraphsGoldenVectors.t.sol:test_ParamsHashEncoding` reached through the
        // factory — if the factory silently altered any governance field, this fails.
        ParamsCodec.Params memory emitted = c.evt.params;
        emitted.schemaUid = goldenJson.readBytes32(".params.schemaUid");
        emitted.accumulator = goldenJson.readAddress(".params.accumulator");
        emitted.chainId = uint64(goldenJson.readUint(".params.chainId"));
        assertEq(
            ParamsCodec.hash(emitted),
            goldenJson.readBytes32(".params.paramsHash"),
            "factory params must round-trip to the golden vector"
        );
    }

    /// The three DERIVED fields are the instance's identity and are filled by the factory alone:
    /// the schema it just registered, the resolver it just deployed, and the chain it is on.
    function test_FactoryFillsTheDerivedIdentityFields() public {
        Created memory c = _create(_args("derived"));

        assertEq(c.evt.params.schemaUid, c.schemaUid, "schemaUid");
        assertEq(c.evt.params.accumulator, c.resolver, "accumulator == this instance's resolver");
        assertEq(c.evt.params.chainId, uint64(block.chainid), "chainId");

        // ...and the schema UID really is the canonical vouch schema bound to that resolver.
        assertEq(
            c.schemaUid,
            keccak256(abi.encodePacked(factory.VOUCH_SCHEMA(), c.resolver, true)),
            "schema UID must bind the instance's own resolver"
        );
    }

    /// The parity holds for any params inside the bounds, not just the golden set.
    function testFuzz_StoredHashEqualsCodecHash(
        uint256 dampingFp,
        uint256 toleranceFp,
        uint32 maxIterations,
        uint256 totalPool
    ) public {
        ParamsCodec.Params memory p = _baseParams();
        p.dampingFp = bound(dampingFp, 1, factory.PRECISION_SCALE() - 1);
        p.toleranceFp = bound(toleranceFp, 1, factory.MAX_TOLERANCE_FP());
        p.maxIterations = uint32(bound(uint256(maxIterations), 1, factory.MAX_ITERATIONS()));
        p.totalPool = bound(totalPool, 1, type(uint128).max);
        // Ranks must not be able to grow, or `_validateGrowth` legitimately rejects the pairing at
        // high iteration counts (see `test_RejectsRunawayGrowth`); this fuzz is about hash parity,
        // not about the growth bound, so pin a multiplier that is safe at any damping.
        p.trustMultiplierFp = 1e18;

        Created memory c = _create(_args("fuzz-params", p));

        ParamsCodec.Params memory expected = p;
        expected.schemaUid = c.schemaUid;
        expected.accumulator = c.resolver;
        expected.chainId = uint64(block.chainid);
        assertEq(MerkleSnapshot(c.snapshot).paramsHash(), ParamsCodec.hash(expected));
    }

    /*//////////////////////////////////////////////////////////////
                     THE EVENT IS THE INTERFACE (M5)
    //////////////////////////////////////////////////////////////*/

    /// THE property the whole M5 prover loop rests on: an instance reconstructed from
    /// `InstanceCreated` alone hashes to the `paramsHash` its snapshot enforces. If this can ever
    /// fail, a prover that trusts the event produces proofs that no snapshot will accept.
    function test_EventParamsHashToTheSnapshotsParamsHash() public {
        TrustgraphsFactory.CreateArgs memory args = _args("event-truth");
        args.withDistributor = true;
        Created memory c = _create(args);

        assertEq(
            ParamsCodec.hash(c.evt.params),
            MerkleSnapshot(c.snapshot).paramsHash(),
            "hash(event.params) must equal snapshot.paramsHash()"
        );
    }

    /// ...and every other field of the event is the real thing too, so the reconstruction needs no
    /// side channel: addresses, the effective epoch, the presentation strings, the token pick.
    function test_EventCarriesTheRealAddressesAndPresentation() public {
        TrustgraphsFactory.CreateArgs memory args = _args("event-fields");
        args.metadataURI = "ipfs://bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        args.admin = bob;
        args.epochLength = EPOCH_FLOOR + 11;
        args.withDistributor = true;
        args.distributorToken = address(0xFEED);

        vm.prank(alice);
        Created memory c = _create(args);

        assertEq(c.evt.instanceId, c.instanceId, "instanceId");
        assertEq(c.evt.creator, alice, "creator is msg.sender, not the admin");
        assertEq(c.evt.admin, bob, "admin");
        assertEq(c.evt.name, "event-fields", "name");
        assertEq(c.evt.metadataURI, args.metadataURI, "metadataURI");
        assertEq(c.evt.resolver, c.resolver, "resolver");
        assertEq(c.evt.schemaUid, c.schemaUid, "schemaUid");
        assertEq(c.evt.snapshot, c.snapshot, "snapshot");
        assertEq(c.evt.distributor, c.distributor, "distributor");
        assertEq(c.evt.distributorToken, address(0xFEED), "distributorToken");
        assertEq(c.evt.epochLength, EPOCH_FLOOR + 11, "EFFECTIVE epoch length");
        assertEq(c.evt.epochLength, MerkleSnapshot(c.snapshot).epochLength(), "event vs chain epoch");
    }

    /// A declined distributor is reported as `address(0)`, not omitted — one event shape for both
    /// paths keeps the indexer's decode unconditional.
    function test_EventReportsZeroDistributorWhenDeclined() public {
        Created memory c = _create(_args("no-fund"));
        assertEq(c.evt.distributor, address(0));
        assertEq(c.distributor, address(0));
    }

    /*//////////////////////////////////////////////////////////////
                          instanceId DERIVATION
    //////////////////////////////////////////////////////////////*/

    /// `instanceId` is `keccak256(abi.encode(creator, name, salt))` — asserted against the value the
    /// event and the registry actually used, not just against a re-computation of the same formula.
    function test_ComputeInstanceIdMatchesWhatWasRegistered() public {
        vm.prank(alice);
        Created memory c = _create(_args("commons"));

        bytes32 expected = factory.computeInstanceId(alice, "commons", bytes32(0));
        assertEq(c.instanceId, expected, "return value");
        assertEq(c.evt.instanceId, expected, "event topic");
        assertTrue(registry.isRegistered(expected), "registry key");
    }

    function testFuzz_ComputeInstanceIdIsKeccakOfCreatorNameSalt(address creator, string calldata name, bytes32 salt)
        public
        view
    {
        assertEq(factory.computeInstanceId(creator, name, salt), keccak256(abi.encode(creator, name, salt)));
    }

    /// The same creator cannot mint the same (name, salt) twice — the registry is the uniqueness
    /// authority and rejects the duplicate id.
    function test_SameCreatorSameNameSameSaltReverts() public {
        vm.startPrank(alice);
        Created memory c = _create(_args("commons"));

        TrustgraphsFactory.CreateArgs memory again = _args("commons");
        vm.expectRevert(abi.encodeWithSelector(IInstanceRegistry.InstanceAlreadyExists.selector, c.instanceId));
        factory.createInstance(again);
        vm.stopPrank();
    }

    /// Squatting is pointless: mixing the creator into the id means Bob taking "commons" does not
    /// stop Alice from having her own "commons".
    function test_SameNameDifferentCreatorSucceedsWithADifferentId() public {
        vm.prank(alice);
        Created memory a = _create(_args("commons"));
        vm.prank(bob);
        Created memory b = _create(_args("commons"));

        assertTrue(a.instanceId != b.instanceId, "ids must differ");
        assertTrue(a.snapshot != b.snapshot, "separate instances");
        assertEq(registry.instanceCount(), 2);
    }

    /// One creator reuses a name via the salt — the documented escape hatch.
    function test_SameCreatorSameNameDifferentSaltSucceeds() public {
        vm.startPrank(alice);
        Created memory a = _create(_args("commons"));

        TrustgraphsFactory.CreateArgs memory second = _args("commons");
        second.salt = bytes32(uint256(1));
        Created memory b = _create(second);
        vm.stopPrank();

        assertTrue(a.instanceId != b.instanceId);
        assertEq(b.instanceId, factory.computeInstanceId(alice, "commons", bytes32(uint256(1))));
    }

    /*//////////////////////////////////////////////////////////////
                          REGISTRY RECORD (M2)
    //////////////////////////////////////////////////////////////*/

    /// The directory row is exactly the instance's contract set, labelled `keccak256("trust-graph")`
    /// so a discovery client can filter by program without reading any config file.
    function test_RegistryRecordIsTheInstance() public {
        Created memory c = _create(_args("catalog"));

        IInstanceRegistry.Instance memory rec = registry.getInstance(c.instanceId);
        assertEq(rec.program, keccak256("trust-graph"), "program label");
        assertEq(rec.program, factory.PROGRAM(), "PROGRAM constant");
        assertEq(rec.snapshot, c.snapshot, "snapshot");
        assertEq(rec.verifier, address(verifier), "shared verifier");
        assertEq(rec.registryOrAccumulator, c.resolver, "lane-1 accumulator");
        assertEq(rec.paramsHash, MerkleSnapshot(c.snapshot).paramsHash(), "paramsHash");
    }

    /// GROUND RULE 4: the record stays presentation-free. Name and metadataURI exist only in the
    /// event — a registry that grew a `name` field would make the directory a naming authority.
    function test_RegistryRecordCarriesNoPresentation() public {
        Created memory c = _create(_args("catalog"));
        IInstanceRegistry.Instance memory rec = registry.getInstance(c.instanceId);
        // The struct has exactly five consensus fields; asserting the encoded width pins that.
        assertEq(abi.encode(rec).length, 5 * 32, "registry record must stay five fields");
    }

    /// Enumeration is append-only and complete: the catalog is the full creation history in order.
    function test_RegistryEnumeratesEveryInstance() public {
        Created memory a = _create(_args("one"));
        Created memory b = _create(_args("two"));

        assertEq(registry.instanceCount(), 2);
        assertEq(registry.instanceIdAt(0), a.instanceId);
        assertEq(registry.instanceIdAt(1), b.instanceId);
    }

    /*//////////////////////////////////////////////////////////////
                              EPOCH FLOOR
    //////////////////////////////////////////////////////////////*/

    /// A too-short request is RAISED to the floor, not rejected — a wizard should never fail on a
    /// number the user has no way to reason about.
    function test_EpochBelowFloorIsRaised() public {
        TrustgraphsFactory.CreateArgs memory args = _args("fast");
        args.epochLength = 1;

        Created memory c = _create(args);
        assertEq(MerkleSnapshot(c.snapshot).epochLength(), EPOCH_FLOOR, "raised on chain");
        assertEq(c.evt.epochLength, EPOCH_FLOOR, "raised in the event");
    }

    /// Zero — "no schedule at all" — is raised too, so no factory instance is ever unscheduled.
    function test_ZeroEpochIsRaisedToTheFloor() public {
        TrustgraphsFactory.CreateArgs memory args = _args("unscheduled");
        args.epochLength = 0;

        Created memory c = _create(args);
        assertEq(MerkleSnapshot(c.snapshot).epochLength(), EPOCH_FLOOR);
    }

    /// A longer cadence is honoured verbatim: the floor is a minimum, not a setting.
    function test_EpochAboveFloorIsHonoured() public {
        TrustgraphsFactory.CreateArgs memory args = _args("slow");
        args.epochLength = 216_000;

        Created memory c = _create(args);
        assertEq(MerkleSnapshot(c.snapshot).epochLength(), 216_000);
        assertEq(c.evt.epochLength, 216_000);
    }

    function testFuzz_EffectiveEpochIsTheMaxOfRequestAndFloor(uint64 requested) public {
        TrustgraphsFactory.CreateArgs memory args = _args("epoch-fuzz");
        args.epochLength = requested;

        Created memory c = _create(args);
        uint64 expected = requested < EPOCH_FLOOR ? EPOCH_FLOOR : requested;
        assertEq(MerkleSnapshot(c.snapshot).epochLength(), expected);
        assertEq(c.evt.epochLength, expected);
        assertGe(c.evt.epochLength, factory.EPOCH_FLOOR(), "never below the floor");
    }

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// Every shared singleton is required; a factory wired to a hole would fail at create time on
    /// somebody else's transaction.
    function test_ConstructorRejectsZeroSingletons() public {
        address[7] memory holes;
        for (uint256 i = 0; i < 7; i++) {
            holes = [
                address(eas),
                address(registrar),
                address(verifier),
                address(registry),
                address(snapshotDeployer),
                address(distributorDeployer),
                address(paramsControllerDeployer)
            ];
            holes[i] = address(0);

            vm.expectRevert(TrustgraphsFactory.ZeroAddress.selector);
            new TrustgraphsFactory(
                IEAS(holes[0]),
                SchemaRegistrar(holes[1]),
                IZkVerifier(holes[2]),
                IInstanceRegistry(holes[3]),
                MerkleSnapshotDeployer(holes[4]),
                MerkleFundDistributorDeployer(holes[5]),
                TrustgraphsParamsControllerDeployer(holes[6]),
                EPOCH_FLOOR,
                vault
            );
        }
    }

    /// A zero floor would mean `epochLength == 0` on every instance, i.e. no schedule at all and
    /// prover-chosen epoch boundaries. Rejected at deployment rather than discovered later.
    function test_ConstructorRejectsZeroEpochFloor() public {
        vm.expectRevert(TrustgraphsFactory.ZeroEpochFloor.selector);
        new TrustgraphsFactory(
            IEAS(address(eas)),
            registrar,
            IZkVerifier(address(verifier)),
            IInstanceRegistry(address(registry)),
            snapshotDeployer,
            distributorDeployer,
            paramsControllerDeployer,
            0,
            vault
        );
    }

    /// The factory's only privilege is one it must actually have: without `REGISTRAR_ROLE` the
    /// whole creation reverts rather than half-deploying an instance that no directory lists.
    function test_CreateRevertsIfTheFactoryIsNotARegistrar() public {
        bytes32 registrarRole = registry.REGISTRAR_ROLE();
        vm.prank(registryAdmin);
        registry.revokeRole(registrarRole, address(factory));

        TrustgraphsFactory.CreateArgs memory args = _args("unlisted");
        vm.expectRevert(abi.encodeWithSelector(IInstanceRegistry.NotRegistrar.selector, address(factory)));
        factory.createInstance(args);
        assertEq(registry.instanceCount(), 0, "a failed create leaves no directory row");
    }

    /// ...and the privilege it must NOT have. `register` and `update` are separate roles precisely
    /// so a compromised factory can append directory rows but never re-point an existing
    /// community's record at a snapshot and verifier of its choosing.
    function test_FactoryCannotRewriteADirectoryRow() public {
        Created memory c = _create(_args("victim"));
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

        assertEq(registry.getInstance(c.instanceId).snapshot, c.snapshot, "the row must be untouched");
    }

    /// Deploy your network endowed with a year of roots, in one transaction. The alternative is
    /// discovering the funding step after the first epoch goes unproven.
    function test_CreateForwardsMsgValueIntoTheInstancesTank() public {
        TrustgraphsFactory.CreateArgs memory args = _args("paid");
        vm.deal(address(this), 5 ether);

        bytes32 id = factory.computeInstanceId(address(this), args.name, args.salt);
        vm.expectEmit(true, true, true, true);
        emit TrustgraphsFactory.InstancePrepaid(id, address(this), 5 ether);
        factory.createInstance{value: 5 ether}(args);

        IProvingVault.Account memory a = vault.accountOf(id);
        assertEq(a.ethBalance, 5 ether, "the tank is funded");
        assertEq(a.snapshot, registry.getInstance(id).snapshot, "and bound to the new snapshot");
        assertEq(address(vault).balance, 5 ether, "the factory kept nothing");
    }

    /// Sending nothing is the normal case and must stay free.
    function test_CreateWithNoValueTouchesNoVault() public {
        Created memory c = _create(_args("free"));
        assertEq(vault.accountOf(c.instanceId).snapshot, address(0), "no account was opened");
    }

    /// A factory deployed without a vault must reject value rather than silently keeping it.
    function test_AFactoryWithNoVaultRejectsValue() public {
        TrustgraphsFactory factory2 = new TrustgraphsFactory(
            IEAS(address(eas)),
            registrar,
            IZkVerifier(address(verifier)),
            IInstanceRegistry(address(registry)),
            snapshotDeployer,
            distributorDeployer,
            paramsControllerDeployer,
            EPOCH_FLOOR,
            IProvingVault(address(0))
        );
        // Read the role BEFORE the prank: a getter is a call, and `vm.prank` applies to the next
        // one, so inlining it here spends the prank on the getter.
        bytes32 registrar = registry.REGISTRAR_ROLE();
        vm.prank(registryAdmin);
        registry.grantRole(registrar, address(factory2));

        vm.deal(address(this), 1 ether);
        vm.expectRevert(TrustgraphsFactory.NoVaultConfigured.selector);
        factory2.createInstance{value: 1 ether}(_args("novault"));

        // ...and the same call succeeds with none, so the rejection is the value, not the shape.
        factory2.createInstance(_args("novault"));
    }

    /*//////////////////////////////////////////////////////////////
                           THE FROZEN INTERFACE
    //////////////////////////////////////////////////////////////*/

    /// The interface-freeze constants, pinned literally. `VOUCH_SCHEMA` in particular is shared by
    /// every factory instance: changing it would fork `weightFieldIndex` and silently invalidate the
    /// schema UID every existing indexer, frontend and guest already resolves.
    function test_FrozenConstants() public view {
        assertEq(factory.VOUCH_SCHEMA(), "string comment,uint256 confidence", "vouch schema");
        assertEq(factory.PROGRAM(), keccak256("trust-graph"), "program label");
        assertEq(factory.PRECISION_SCALE(), 1e18, "S is the guest's constant");
        assertEq(uint256(factory.WEIGHT_FIELD_INDEX()), 1, "confidence is ABI head slot 1");
        assertEq(factory.EPOCH_FLOOR(), EPOCH_FLOOR, "floor is immutable");
    }

    /// `InstanceCreated`'s topic0 — i.e. its whole signature, params tuple included — is the
    /// interface provers and indexers subscribe to. Freeze it like a journal: this literal is what a
    /// consumer hard-codes, and a field added, moved or retyped changes it.
    function test_InstanceCreatedSignatureIsFrozen() public pure {
        assertEq(
            TrustgraphsFactory.InstanceCreated.selector,
            keccak256(
                "InstanceCreated(bytes32,address,address,string,string,address,bytes32,address,address,address,uint64,(uint256,uint256,uint32,uint256,uint256,uint256,uint256,uint256,address[],uint256,uint256,bytes32,uint32,bytes32[],uint64,address,uint64))"
            ),
            "InstanceCreated is frozen"
        );
    }
}
