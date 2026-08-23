// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {SchemaRegistrar} from "src/eas/SchemaRegistrar.sol";
import {ContributionResolver} from "src/eas/resolvers/ContributionResolver.sol";
import {ContributionsFactory} from "src/factory/ContributionsFactory.sol";
import {ContributionsParamsController} from "src/factory/ContributionsParamsController.sol";
import {ContributionsParamsControllerDeployer} from "src/factory/ContributionsInstanceDeployers.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {
    MerkleSnapshotDeployer,
    MerkleFundDistributorDeployer,
    TrustgraphsParamsControllerDeployer
} from "src/factory/InstanceDeployers.sol";
import {EasOffchainAnchorRegistryDeployer} from "src/factory/HybridInstanceDeployers.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {SP1JournalVerifier} from "src/merkle/SP1JournalVerifier.sol";
import {TrustAccumulatorMirror} from "src/merkle/TrustAccumulatorMirror.sol";
import {ContributionsParamsCodec} from "src/params/ContributionsParamsCodec.sol";
import {ContributionsParamsValidator} from "src/params/ContributionsParamsValidator.sol";
import {ParamsCodec} from "src/params/ParamsCodec.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IContributionsParamsController} from "interfaces/factory/IContributionsParamsController.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {ISP1Verifier} from "interfaces/merkle/ISP1Verifier.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";

import {MockSP1Gateway} from "../../mocks/MockSP1Gateway.sol";
import {MockZkVerifier} from "../../mocks/MockZkVerifier.sol";
import {MockSafeOwner} from "../../helpers/MockSafeOwner.sol";

/// @title ContributionsFactoryTest
/// @notice The M6 battery: one-transaction round creation against a LIVE parent (created through
///         the real `TrustgraphsFactory`, so the parent gate is exercised against real role
///         wiring), the parent gate itself, schema squatting ×3, the M6-1 mirror-bind regression,
///         validator bounds, ground-rule-3 inertness, EIP-170 headroom, and a recorded gas number.
contract ContributionsFactoryTest is Test {
    /*//////////////////////////////////////////////////////////////
                                 THE RIG
    //////////////////////////////////////////////////////////////*/

    SchemaRegistry internal schemaRegistry;
    EAS internal eas;
    SchemaRegistrar internal registrar;
    InstanceRegistry internal registry;
    MerkleSnapshotDeployer internal snapshotDeployer;
    MerkleFundDistributorDeployer internal distributorDeployer;

    // The parent lane: a real trust-graph factory so the parent is a REAL instance.
    MockZkVerifier internal trustVerifier;
    TrustgraphsParamsControllerDeployer internal trustControllerDeployer;
    TrustgraphsFactory internal trustFactory;

    // The contributions lane under test.
    SP1JournalVerifier internal contributionsVerifier;
    ContributionsParamsControllerDeployer internal contributionsControllerDeployer;
    ContributionsFactory internal factory;

    address internal registryAdmin = address(0x0BE7);
    /// The parent network's admin — the only address allowed to hang rounds on it.
    address internal parentAdmin = address(0xA11CE);
    address internal stranger = address(0xBAD);
    MockSafeOwner internal roundSafe;

    uint64 internal constant EPOCH_FLOOR = 5;
    bytes32 internal constant CONTRIBUTIONS_VKEY = bytes32(uint256(0xC0117B));

    bytes32 internal parentId;
    address internal parentSnapshot;
    address internal parentResolver;

    /*//////////////////////////////////////////////////////////////
                          DECODED EVENT / RESULT
    //////////////////////////////////////////////////////////////*/

    struct CreatedEvent {
        bytes32 instanceId;
        bytes32 parentInstanceId;
        address creator;
        address admin;
        string name;
        string metadataURI;
        address trustAccumulator;
        address mirror;
        address resolver;
        address snapshot;
        address distributor;
        address distributorToken;
        uint64 epochLength;
        bytes32 claimSchemaUid;
        bytes32 responseSchemaUid;
        bytes32 valuationSchemaUid;
        ContributionsParamsCodec.Params params;
    }

    struct Created {
        bytes32 instanceId;
        address snapshot;
        address resolver;
        address mirror;
        address distributor;
        address admin;
        address controller;
        CreatedEvent evt;
        Vm.Log[] logs;
    }

    function setUp() public {
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        registrar = new SchemaRegistrar(ISchemaRegistry(address(schemaRegistry)));
        registry = new InstanceRegistry(registryAdmin);
        snapshotDeployer = new MerkleSnapshotDeployer();
        distributorDeployer = new MerkleFundDistributorDeployer();
        roundSafe = new MockSafeOwner(parentAdmin, 1);

        // --- Parent factory (trust-graph), no vault: prepay is not under test here. ---
        trustVerifier = new MockZkVerifier();
        trustControllerDeployer = new TrustgraphsParamsControllerDeployer();
        trustFactory = new TrustgraphsFactory(
            IEAS(address(eas)),
            registrar,
            IZkVerifier(address(trustVerifier)),
            IInstanceRegistry(address(registry)),
            snapshotDeployer,
            distributorDeployer,
            trustControllerDeployer,
            new EasOffchainAnchorRegistryDeployer(),
            EPOCH_FLOOR,
            IProvingVault(address(0))
        );

        // --- Contributions factory under test: a REAL SP1JournalVerifier over a mock gateway, ---
        // --- so the constructor's programVKey() cross-check runs against the real seam.       ---
        contributionsVerifier = new SP1JournalVerifier(ISP1Verifier(address(new MockSP1Gateway())), CONTRIBUTIONS_VKEY);
        contributionsControllerDeployer = new ContributionsParamsControllerDeployer();
        factory = new ContributionsFactory(
            IEAS(address(eas)),
            registrar,
            IZkVerifier(address(contributionsVerifier)),
            CONTRIBUTIONS_VKEY,
            IInstanceRegistry(address(registry)),
            snapshotDeployer,
            distributorDeployer,
            contributionsControllerDeployer,
            EPOCH_FLOOR
        );

        bytes32 registrarRole = registry.REGISTRAR_ROLE();
        vm.startPrank(registryAdmin);
        registry.grantRole(registrarRole, address(trustFactory));
        registry.grantRole(registrarRole, address(factory));
        vm.stopPrank();

        // --- The live parent: created through the real factory, admin = parentAdmin. ---
        (parentId, parentSnapshot, parentResolver,,) = trustFactory.createInstance(_trustArgs("parent-network"));
    }

    /*//////////////////////////////////////////////////////////////
                                 PARAMS
    //////////////////////////////////////////////////////////////*/

    /// @dev A valid trust-graph creation tuple (derived fields zero), hand-rolled inside the
    ///      factory's own envelope.
    function _trustParams() internal pure returns (ParamsCodec.Params memory p) {
        p.dampingFp = 0.85e18;
        p.toleranceFp = 1e12;
        p.maxIterations = 50;
        p.minWeightFp = 0;
        p.maxWeightFp = 100e18;
        p.trustShareFp = 0.5e18;
        p.trustDecayFp = 0.5e18;
        p.trustedSeeds = new address[](2);
        p.trustedSeeds[0] = address(0x5EED1);
        p.trustedSeeds[1] = address(0x5EED2);
        p.totalPool = 1e24;
        p.precisionScale = 1e18;
        p.weightFieldIndex = 1;
    }

    function _trustArgs(string memory name) internal view returns (TrustgraphsFactory.CreateArgs memory args) {
        args.name = name;
        args.metadataURI = "";
        args.params = _trustParams();
        args.admin = parentAdmin;
        args.epochLength = EPOCH_FLOOR;
    }

    /// @dev A valid 21-field contributions tuple with the three DERIVED schema UIDs left at zero.
    function _contribParams() internal pure returns (ContributionsParamsCodec.Params memory p) {
        p.dampingFp = 0.85e18;
        p.toleranceFp = 1e12;
        p.maxIterations = 50;
        p.minWeightFp = 0;
        p.maxWeightFp = 100e18;
        p.trustShareFp = 0.5e18;
        p.trustDecayFp = 0.5e18;
        p.trustedSeeds = new address[](2);
        p.trustedSeeds[0] = address(0x5EED1);
        p.trustedSeeds[1] = address(0x5EED2);
        p.precisionScale = 1e18;
        p.weightFieldIndex = 1;
        p.roundStart = 1_000;
        p.roundEnd = 2_000;
        p.unacceptedMultFp = 0.5e18;
        p.collaboratorMultFp = 0.5e18;
        p.minRaterRepFp = 0;
        p.evaluatorCarveoutBps = 100;
        p.totalPool = 1_000_000e6;
    }

    function _args(string memory name) internal view returns (ContributionsFactory.CreateArgs memory args) {
        args.parentInstanceId = parentId;
        args.name = name;
        args.metadataURI = "ipfs://bafkreiexampleroundmetadata";
        args.params = _contribParams();
        args.admin = address(roundSafe);
        args.epochLength = EPOCH_FLOOR;
    }

    /*//////////////////////////////////////////////////////////////
                            CREATE + CAPTURE
    //////////////////////////////////////////////////////////////*/

    function _create(ContributionsFactory.CreateArgs memory args) internal returns (Created memory c) {
        vm.recordLogs();
        vm.prank(parentAdmin);
        (c.instanceId, c.snapshot, c.resolver, c.mirror, c.distributor) = factory.createInstance(args);
        c.logs = vm.getRecordedLogs();
        c.evt = _decodeCreated(c.logs);
        c.admin = c.evt.admin;
        c.controller = _decodeController(c.logs, c.instanceId);
    }

    function _decodeCreated(Vm.Log[] memory logs) internal view returns (CreatedEvent memory e) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(factory) || logs[i].topics.length != 4) continue;
            if (logs[i].topics[0] != ContributionsFactory.ContributionsInstanceCreated.selector) continue;

            e.instanceId = logs[i].topics[1];
            e.parentInstanceId = logs[i].topics[2];
            e.creator = address(uint160(uint256(logs[i].topics[3])));
            (
                e.admin,
                e.name,
                e.metadataURI,
                e.trustAccumulator,
                e.mirror,
                e.resolver,
                e.snapshot,
                e.distributor,
                e.distributorToken,
                e.epochLength,
                e.claimSchemaUid,
                e.responseSchemaUid,
                e.valuationSchemaUid,
                e.params
            ) =
                abi.decode(
                    logs[i].data,
                    (
                        address,
                        string,
                        string,
                        address,
                        address,
                        address,
                        address,
                        address,
                        address,
                        uint64,
                        bytes32,
                        bytes32,
                        bytes32,
                        ContributionsParamsCodec.Params
                    )
                );
            return e;
        }
        revert("ContributionsInstanceCreated was not emitted");
    }

    function _decodeController(Vm.Log[] memory logs, bytes32 instanceId) internal view returns (address) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(factory) || logs[i].topics.length != 3) continue;
            if (logs[i].topics[0] != ContributionsFactory.ContributionsParamsControllerCreated.selector) continue;
            if (logs[i].topics[1] != instanceId) continue;
            return address(uint160(uint256(logs[i].topics[2])));
        }
        revert("ContributionsParamsControllerCreated was not emitted");
    }

    /*//////////////////////////////////////////////////////////////
                              HAPPY PATH
    //////////////////////////////////////////////////////////////*/

    function test_CreateRoundAgainstLiveParent() public {
        Created memory c = _create(_args("first-round"));

        // Return tuple sanity + id derivation.
        assertEq(c.instanceId, factory.computeInstanceId(parentAdmin, "first-round", bytes32(0)));
        assertEq(c.evt.instanceId, c.instanceId);
        assertEq(c.evt.parentInstanceId, parentId, "event must carry the parent link");
        assertEq(c.evt.creator, parentAdmin);
        assertEq(c.evt.admin, address(roundSafe), "the round fund is Safe-owned from genesis");
        assertEq(c.evt.trustAccumulator, parentResolver, "lane-1 source must be the parent's accumulator");
        assertEq(c.evt.mirror, c.mirror);
        assertEq(c.evt.resolver, c.resolver);
        assertEq(c.evt.snapshot, c.snapshot);
        assertEq(c.evt.distributor, c.distributor);
        assertEq(c.evt.epochLength, EPOCH_FLOOR);

        // The registry row is the reconstruction record operator-core reads.
        IInstanceRegistry.Instance memory record = registry.getInstance(c.instanceId);
        assertEq(record.program, keccak256("contributions"));
        assertEq(record.snapshot, c.snapshot);
        assertEq(record.verifier, address(contributionsVerifier));
        assertEq(record.registryOrAccumulator, c.resolver);
        assertEq(registry.paramsAuthority(c.instanceId), c.controller);

        // Five-way agreement (operator-core catalog.rs): controller id/snapshot/eas, and
        // hash(full tuple) == controller hash == snapshot live hash == registry hash.
        ContributionsParamsController controller = ContributionsParamsController(c.controller);
        assertEq(controller.instanceId(), c.instanceId);
        assertEq(controller.snapshot(), c.snapshot);
        assertEq(controller.eas(), address(eas));
        bytes32 reconstructed = ContributionsParamsCodec.hash(controller.getContributionsParams());
        assertEq(reconstructed, controller.currentParamsHash());
        assertEq(controller.currentParamsHash(), MerkleSnapshot(c.snapshot).paramsHash());
        assertEq(controller.currentParamsHash(), record.paramsHash);
        assertTrue(
            MerkleSnapshot(c.snapshot).provenanceEnabled(),
            "the composition-source window must open at mint: no later actor can ever open it"
        );
        assertTrue(controller.versionOnePublished(), "version 1 must be published in the creating tx");

        // The event's params are the FINAL tuple: derived UIDs filled, hash reproduces the pin.
        assertEq(ContributionsParamsCodec.hash(c.evt.params), record.paramsHash);
        assertEq(c.evt.params.claimSchemaUid, c.evt.claimSchemaUid);
        assertEq(c.evt.params.responseSchemaUid, c.evt.responseSchemaUid);
        assertEq(c.evt.params.valuationSchemaUid, c.evt.valuationSchemaUid);

        // Resolver allowlist bound to exactly the three registered schemas.
        ContributionResolver resolver = ContributionResolver(payable(c.resolver));
        assertTrue(resolver.schemasSet());
        assertEq(resolver.claimSchemaUid(), c.evt.claimSchemaUid);
        assertEq(resolver.responseSchemaUid(), c.evt.responseSchemaUid);
        assertEq(resolver.valuationSchemaUid(), c.evt.valuationSchemaUid);
        assertEq(
            c.evt.claimSchemaUid,
            keccak256(abi.encodePacked(factory.CLAIM_SCHEMA(), c.resolver, true)),
            "claim UID must be EAS's documented derivation"
        );

        // Two-lane wiring: slot A through the mirror, slot B through the resolver.
        MerkleSnapshot snapshot = MerkleSnapshot(c.snapshot);
        assertEq(address(snapshot.accumulator()), c.mirror);
        assertEq(address(snapshot.anchorRegistry()), c.resolver);
        assertEq(address(TrustAccumulatorMirror(c.mirror).trustAccumulator()), parentResolver);
        assertEq(TrustAccumulatorMirror(c.mirror).snapshot(), c.snapshot, "M6-1: mirror must be bound");
        assertEq(snapshot.epochLength(), EPOCH_FLOOR);

        // Ordering: the creation event precedes the controller's first published version, so an
        // ordered indexer has materialized the round row before any controller event arrives.
        _assertDiscoveryBeforeChildren(c);
    }

    function test_AttestationsFoldAfterCreation() public {
        Created memory c = _create(_args("attestable-round"));
        // A member can attest against the round's claim schema immediately; the resolver folds it.
        vm.prank(stranger);
        eas.attest(
            AttestationRequest({
                schema: c.evt.claimSchemaUid,
                data: AttestationRequestData({
                    recipient: address(0),
                    expirationTime: 0,
                    revocable: true,
                    refUID: bytes32(0),
                    data: _claimPayload(),
                    value: 0
                })
            })
        );
        assertEq(ContributionResolver(payable(c.resolver)).leafCount(), 1, "the claim must fold into lane 2");
    }

    function _claimPayload() internal pure returns (bytes memory) {
        address[] memory contributors = new address[](1);
        contributors[0] = address(0xC0FFEE);
        uint32[] memory shares = new uint32[](1);
        shares[0] = 100;
        return abi.encode("built the thing", bytes32(uint256(1)), "ipfs://work", contributors, shares);
    }

    /// @dev Discovery-before-children, asserted on the events indexers actually SUBSCRIBE to: the
    ///      creation event precedes the controller-discovery event, which precedes the
    ///      controller's first `ContributionsParamsUpdated` (deferred `publishInitialVersion`).
    ///      The controller's constructor also emits OZ `OwnershipTransferred`, which nothing
    ///      consumes — that one may legitimately appear earlier.
    function _assertDiscoveryBeforeChildren(Created memory c) internal view {
        bytes32 paramsUpdatedTopic = IContributionsParamsController.ContributionsParamsUpdated.selector;
        uint256 createdAt = type(uint256).max;
        uint256 controllerCreatedAt = type(uint256).max;
        uint256 firstParamsUpdateAt = type(uint256).max;
        for (uint256 i = 0; i < c.logs.length; i++) {
            bytes32 topic0 = c.logs[i].topics[0];
            if (
                c.logs[i].emitter == address(factory)
                    && topic0 == ContributionsFactory.ContributionsInstanceCreated.selector
            ) createdAt = i;
            if (
                c.logs[i].emitter == address(factory)
                    && topic0 == ContributionsFactory.ContributionsParamsControllerCreated.selector
            ) controllerCreatedAt = i;
            if (
                c.logs[i].emitter == c.controller && topic0 == paramsUpdatedTopic
                    && firstParamsUpdateAt == type(uint256).max
            ) firstParamsUpdateAt = i;
        }
        assertTrue(firstParamsUpdateAt != type(uint256).max, "version 1 must be published");
        assertLt(createdAt, controllerCreatedAt, "creation event must precede controller discovery");
        assertLt(controllerCreatedAt, firstParamsUpdateAt, "controller discovery must precede its first consumed event");
    }

    function test_MultipleRoundsPerParent() public {
        Created memory a = _create(_args("round-one"));
        Created memory b = _create(_args("round-two"));
        assertTrue(a.instanceId != b.instanceId);
        assertTrue(registry.isRegistered(a.instanceId));
        assertTrue(registry.isRegistered(b.instanceId));
        // Same parent, two live rounds: the one-active-round framing is presentation, not contract.
        assertEq(_decodeCreated(a.logs).parentInstanceId, parentId);
        assertEq(_decodeCreated(b.logs).parentInstanceId, parentId);
    }

    function test_EpochLengthRaisedToFloor() public {
        ContributionsFactory.CreateArgs memory args = _args("floored-round");
        args.epochLength = 1;
        Created memory c = _create(args);
        assertEq(MerkleSnapshot(c.snapshot).epochLength(), EPOCH_FLOOR);
        assertEq(c.evt.epochLength, EPOCH_FLOOR, "the event must carry the EFFECTIVE epoch length");
    }

    function test_ExplicitAdminReceivesEverything() public {
        address roundAdmin = address(new MockSafeOwner(address(0xAD314), 1));
        ContributionsFactory.CreateArgs memory args = _args("delegated-round");
        args.admin = roundAdmin;
        Created memory c = _create(args);
        MerkleSnapshot snapshot = MerkleSnapshot(c.snapshot);
        assertTrue(snapshot.hasRole(snapshot.CONSTITUTIONAL_ROLE(), roundAdmin));
        assertEq(ContributionsParamsController(c.controller).owner(), roundAdmin);
        assertEq(MerkleFundDistributor(payable(c.distributor)).owner(), roundAdmin);
        assertEq(MerkleFundDistributor(payable(c.distributor)).feeRecipient(), roundAdmin);
    }

    function test_RevertWhen_DistributorAdminIsAnEoa() public {
        ContributionsFactory.CreateArgs memory args = _args("eoa-owned-round");
        args.admin = parentAdmin;
        vm.expectRevert(abi.encodeWithSelector(ContributionsFactory.InvalidDistributorSafe.selector, parentAdmin));
        vm.prank(parentAdmin);
        factory.createInstance(args);
    }

    /*//////////////////////////////////////////////////////////////
                             THE PARENT GATE
    //////////////////////////////////////////////////////////////*/

    function test_RevertWhen_CallerIsNotParentAuthority() public {
        ContributionsFactory.CreateArgs memory args = _args("ambush-round");
        vm.expectRevert(abi.encodeWithSelector(ContributionsFactory.NotParentAuthority.selector, parentId, stranger));
        vm.prank(stranger);
        factory.createInstance(args);
    }

    function test_RevertWhen_ParentIsUnknown() public {
        ContributionsFactory.CreateArgs memory args = _args("orphan-round");
        args.parentInstanceId = keccak256("no such parent");
        vm.expectRevert(abi.encodeWithSelector(IInstanceRegistry.InstanceNotFound.selector, args.parentInstanceId));
        vm.prank(parentAdmin);
        factory.createInstance(args);
    }

    function test_RevertWhen_ParentIsNotTrustGraph() public {
        // A contributions round is itself a registered instance — but not a legal parent.
        Created memory c = _create(_args("legit-round"));
        ContributionsFactory.CreateArgs memory args = _args("round-on-a-round");
        args.parentInstanceId = c.instanceId;
        vm.expectRevert(
            abi.encodeWithSelector(
                ContributionsFactory.ParentNotTrustGraph.selector, c.instanceId, keccak256("contributions")
            )
        );
        vm.prank(parentAdmin);
        factory.createInstance(args);
    }

    function test_ValidateParentView() public {
        assertEq(factory.validateParent(parentId, parentAdmin), parentResolver);
        vm.expectRevert(abi.encodeWithSelector(ContributionsFactory.NotParentAuthority.selector, parentId, stranger));
        factory.validateParent(parentId, stranger);
    }

    function test_HybridTrustGraphCannotBeUsedAsContributionsParent() public {
        TrustgraphsFactory.OffchainEasConfig memory offchain;
        offchain.maxTotalInputs = 200_000;
        offchain.initialRelayers = new address[](2);
        offchain.initialRelayers[0] = address(0x111);
        offchain.initialRelayers[1] = address(0x222);
        (bytes32 hybridId, address hybridSnapshot,,,) =
            trustFactory.createHybridInstance(_trustArgs("hybrid-parent"), offchain);
        address anchorRegistry = address(MerkleSnapshot(hybridSnapshot).anchorRegistry());

        ContributionsFactory.CreateArgs memory args = _args("hybrid-child");
        args.parentInstanceId = hybridId;
        vm.expectRevert(
            abi.encodeWithSelector(ContributionsFactory.HybridParentUnsupported.selector, hybridId, anchorRegistry)
        );
        vm.prank(parentAdmin);
        factory.createInstance(args);

        vm.expectRevert(
            abi.encodeWithSelector(ContributionsFactory.HybridParentUnsupported.selector, hybridId, anchorRegistry)
        );
        factory.validateParent(hybridId, parentAdmin);
    }

    function test_GovernedStyleAuthorityTransferMovesTheGate() public {
        // The gate follows the parent's LIVE constitutional role, not creation history.
        address successor = address(0x5AFE);
        vm.prank(parentAdmin);
        MerkleSnapshot(parentSnapshot).proposeConstitutionalTransfer(successor);
        vm.prank(successor);
        MerkleSnapshot(parentSnapshot).acceptConstitutionalTransfer();

        ContributionsFactory.CreateArgs memory args = _args("post-handoff-round");
        vm.expectRevert(abi.encodeWithSelector(ContributionsFactory.NotParentAuthority.selector, parentId, parentAdmin));
        vm.prank(parentAdmin);
        factory.createInstance(args);

        vm.prank(successor);
        factory.createInstance(_args("successor-round"));
    }

    /*//////////////////////////////////////////////////////////////
                            SCHEMA SQUATTING
    //////////////////////////////////////////////////////////////*/

    function test_SchemaSquatX3IsAdoptedNotBricked() public {
        // Predict the resolver address (plain CREATE from the factory) and pre-register all three
        // exact tuples, the way a squatter would.
        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        vm.startPrank(stranger);
        registrar.register(factory.CLAIM_SCHEMA(), ISchemaResolver(predicted), true);
        registrar.register(factory.RESPONSE_SCHEMA(), ISchemaResolver(predicted), true);
        registrar.register(factory.VALUATION_SCHEMA(), ISchemaResolver(predicted), true);
        vm.stopPrank();

        Created memory c = _create(_args("squatted-round"));
        assertEq(c.resolver, predicted, "the squat only matters if it hit the real address");

        // All three registrations were adopted; the round is fully functional regardless.
        uint256 adopted;
        for (uint256 i = 0; i < c.logs.length; i++) {
            if (
                c.logs[i].emitter == address(factory)
                    && c.logs[i].topics[0] == ContributionsFactory.SchemaAdopted.selector
            ) {
                assertEq(c.logs[i].topics[1], c.instanceId);
                (uint8 schemaIndex, bytes32 uid) = abi.decode(c.logs[i].data, (uint8, bytes32));
                assertEq(uint256(schemaIndex), adopted, "adoption order must be claim, response, valuation");
                assertTrue(uid != bytes32(0));
                adopted++;
            }
        }
        assertEq(adopted, 3, "every squatted schema must be adopted");
        assertTrue(ContributionResolver(payable(c.resolver)).schemasSet());
    }

    function test_NoSquatMeansNoAdoptionEvent() public {
        Created memory c = _create(_args("clean-round"));
        for (uint256 i = 0; i < c.logs.length; i++) {
            assertTrue(
                !(c.logs[i].emitter == address(factory)
                        && c.logs[i].topics[0] == ContributionsFactory.SchemaAdopted.selector),
                "no adoption event on the clean path"
            );
        }
    }

    /*//////////////////////////////////////////////////////////////
                        M6-1 MIRROR-BIND REGRESSION
    //////////////////////////////////////////////////////////////*/

    function test_M61_DirectMirrorCheckpointReverts() public {
        Created memory c = _create(_args("guarded-round"));
        // The attack's first step: mint a mirror checkpoint that trigger() never created, so the
        // lane-2 freeze reads (0,0) and a contributions-blind proof would verify against it.
        vm.expectRevert(TrustAccumulatorMirror.NotSnapshot.selector);
        vm.prank(stranger);
        TrustAccumulatorMirror(c.mirror).checkpoint();
    }

    function test_M61_TriggerIsTheOnlyCheckpointMint() public {
        Created memory c = _create(_args("triggered-round"));
        vm.roll(block.number + EPOCH_FLOOR);
        uint256 id = MerkleSnapshot(c.snapshot).trigger();
        assertEq(id, 0);
        assertEq(TrustAccumulatorMirror(c.mirror).checkpointCount(), 1);
        // Both lanes frozen under one id: the anchor (lane-2) freeze exists for this id.
        (bytes32 anchorAcc, uint64 anchorCount) = MerkleSnapshot(c.snapshot).anchorCheckpoints(id);
        assertEq(anchorAcc, bytes32(0));
        assertEq(anchorCount, 0);
        assertEq(MerkleSnapshot(c.snapshot).nextCheckpointId(), 1);
    }

    /*//////////////////////////////////////////////////////////////
                       PARAMS VALIDATOR BOUNDS
    //////////////////////////////////////////////////////////////*/

    function _expectCreateRevert(ContributionsParamsCodec.Params memory p, bytes memory err) internal {
        ContributionsFactory.CreateArgs memory args = _args("bad-params-round");
        args.params = p;
        vm.expectRevert(err);
        vm.prank(parentAdmin);
        factory.createInstance(args);
        // And the wizard's pre-flight view rejects identically.
        vm.expectRevert(err);
        factory.validateParams(p);
    }

    function test_RevertWhen_DerivedSchemaUidNotZero() public {
        ContributionsParamsCodec.Params memory p = _contribParams();
        p.claimSchemaUid = bytes32(uint256(1));
        _expectCreateRevert(p, abi.encodeWithSelector(ContributionsParamsValidator.DerivedFieldNotZero.selector));
    }

    function test_RevertWhen_RoundWindowInverted() public {
        ContributionsParamsCodec.Params memory p = _contribParams();
        p.roundStart = 2_000;
        p.roundEnd = 1_000;
        _expectCreateRevert(
            p, abi.encodeWithSelector(ContributionsParamsValidator.InvalidRoundWindow.selector, 2_000, 1_000)
        );
    }

    function test_RevertWhen_RoundWindowEmpty() public {
        ContributionsParamsCodec.Params memory p = _contribParams();
        p.roundStart = 1_500;
        p.roundEnd = 1_500;
        _expectCreateRevert(
            p, abi.encodeWithSelector(ContributionsParamsValidator.InvalidRoundWindow.selector, 1_500, 1_500)
        );
    }

    function test_RevertWhen_CarveoutOver100Percent() public {
        ContributionsParamsCodec.Params memory p = _contribParams();
        p.evaluatorCarveoutBps = 10_001;
        _expectCreateRevert(p, abi.encodeWithSelector(ContributionsParamsValidator.InvalidCarveout.selector, 10_001));
    }

    function test_RevertWhen_UnacceptedMultiplierOverScale() public {
        ContributionsParamsCodec.Params memory p = _contribParams();
        p.unacceptedMultFp = 1e18 + 1;
        _expectCreateRevert(
            p, abi.encodeWithSelector(ContributionsParamsValidator.InvalidUnacceptedMultiplier.selector, 1e18 + 1)
        );
    }

    function test_RevertWhen_CollaboratorMultiplierOverScale() public {
        ContributionsParamsCodec.Params memory p = _contribParams();
        p.collaboratorMultFp = 1e18 + 1;
        _expectCreateRevert(
            p, abi.encodeWithSelector(ContributionsParamsValidator.InvalidCollaboratorMultiplier.selector, 1e18 + 1)
        );
    }

    function test_RevertWhen_PoolIsZero() public {
        ContributionsParamsCodec.Params memory p = _contribParams();
        p.totalPool = 0;
        _expectCreateRevert(p, abi.encodeWithSelector(ContributionsParamsValidator.InvalidTotalPool.selector, 0));
    }

    function test_RevertWhen_PoolExceedsFixedPointHeadroom() public {
        ContributionsParamsCodec.Params memory p = _contribParams();
        p.totalPool = type(uint256).max / 1e18 + 1;
        _expectCreateRevert(
            p, abi.encodeWithSelector(ContributionsParamsValidator.InvalidTotalPool.selector, p.totalPool)
        );
    }

    function test_RevertWhen_TrustBoundsViolated() public {
        // Spot-check that the stage-1 (trust-mirrored) envelope really is enforced here too.
        ContributionsParamsCodec.Params memory p = _contribParams();
        p.dampingFp = 1e18;
        _expectCreateRevert(p, abi.encodeWithSelector(ContributionsParamsValidator.InvalidDamping.selector, 1e18));

        p = _contribParams();
        p.maxIterations = 501;
        _expectCreateRevert(p, abi.encodeWithSelector(ContributionsParamsValidator.InvalidIterations.selector, 501));

        p = _contribParams();
        p.trustedSeeds = new address[](0);
        _expectCreateRevert(p, abi.encodeWithSelector(ContributionsParamsValidator.NoTrustedSeeds.selector));

        p = _contribParams();
        p.trustedSeeds[1] = p.trustedSeeds[0];
        _expectCreateRevert(
            p, abi.encodeWithSelector(ContributionsParamsValidator.InvalidSeed.selector, p.trustedSeeds[0])
        );

        p = _contribParams();
        p.precisionScale = 1e17;
        _expectCreateRevert(
            p, abi.encodeWithSelector(ContributionsParamsValidator.InvalidPrecisionScale.selector, 1e17)
        );

        p = _contribParams();
        p.toleranceFp = 1e6 - 1;
        _expectCreateRevert(
            p, abi.encodeWithSelector(ContributionsParamsValidator.InvalidTolerance.selector, uint256(1e6 - 1))
        );
    }

    function test_RevertWhen_NameEmptyOrTooLong() public {
        ContributionsFactory.CreateArgs memory args = _args("");
        vm.expectRevert(ContributionsFactory.EmptyName.selector);
        vm.prank(parentAdmin);
        factory.createInstance(args);

        bytes memory longName = new bytes(65);
        for (uint256 i = 0; i < longName.length; i++) {
            longName[i] = "x";
        }
        args = _args(string(longName));
        vm.expectRevert(abi.encodeWithSelector(ContributionsFactory.NameTooLong.selector, 65));
        vm.prank(parentAdmin);
        factory.createInstance(args);
    }

    function test_RevertWhen_FactoryNamedAsAdmin() public {
        ContributionsFactory.CreateArgs memory args = _args("self-brick");
        args.admin = address(factory);
        vm.expectRevert(ContributionsFactory.InvalidAdmin.selector);
        vm.prank(parentAdmin);
        factory.createInstance(args);
    }

    /*//////////////////////////////////////////////////////////////
                       CONSTRUCTOR CROSS-CHECKS
    //////////////////////////////////////////////////////////////*/

    function test_RevertWhen_VerifierProvesWrongGuest() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                ContributionsFactory.ProgramVKeyMismatch.selector, bytes32(uint256(0xDEAD)), CONTRIBUTIONS_VKEY
            )
        );
        new ContributionsFactory(
            IEAS(address(eas)),
            registrar,
            IZkVerifier(address(contributionsVerifier)),
            bytes32(uint256(0xDEAD)),
            IInstanceRegistry(address(registry)),
            snapshotDeployer,
            distributorDeployer,
            contributionsControllerDeployer,
            EPOCH_FLOOR
        );
    }

    function test_RevertWhen_VerifierHasNoProgramVKey() public {
        vm.expectRevert(ContributionsFactory.InvalidContributionsVerifier.selector);
        new ContributionsFactory(
            IEAS(address(eas)),
            registrar,
            IZkVerifier(address(trustVerifier)), // MockZkVerifier: no programVKey()
            CONTRIBUTIONS_VKEY,
            IInstanceRegistry(address(registry)),
            snapshotDeployer,
            distributorDeployer,
            contributionsControllerDeployer,
            EPOCH_FLOOR
        );
    }

    /*//////////////////////////////////////////////////////////////
                    GROUND RULE 3 — INERTNESS
    //////////////////////////////////////////////////////////////*/

    function test_FactoryAndDeployersAreInertAfterCreation() public {
        Created memory c = _create(_args("inert-round"));
        MerkleSnapshot snapshot = MerkleSnapshot(c.snapshot);

        bytes32 constitutional = snapshot.CONSTITUTIONAL_ROLE();
        bytes32 operational = snapshot.OPERATIONAL_ROLE();
        bytes32 defaultAdmin = snapshot.DEFAULT_ADMIN_ROLE();

        // Every role the transaction touched, enumerated from the logs — a fourth role added to
        // MerkleSnapshot later is still checked.
        bytes32[] memory touched = _rolesTouched(c.logs);
        assertGe(touched.length, 2, "the create tx must have granted at least two roles");
        for (uint256 i = 0; i < touched.length; i++) {
            _assertHoldsNothing(snapshot, touched[i]);
        }
        _assertHoldsNothing(snapshot, constitutional);
        _assertHoldsNothing(snapshot, operational);
        _assertHoldsNothing(snapshot, defaultAdmin);

        assertTrue(snapshot.hasRole(constitutional, c.admin), "admin must hold CONSTITUTIONAL_ROLE");
        assertFalse(snapshot.hasRole(operational, c.admin), "admin must not retain the raw-hash path");
        assertTrue(snapshot.hasRole(operational, c.controller), "controller must hold OPERATIONAL_ROLE");
        assertFalse(snapshot.hasRole(defaultAdmin, c.admin), "nobody may hold DEFAULT_ADMIN_ROLE");

        ContributionsParamsController controller = ContributionsParamsController(c.controller);
        assertEq(controller.owner(), c.admin);
        assertEq(controller.pendingOwner(), address(0));

        MerkleFundDistributor dist = MerkleFundDistributor(payable(c.distributor));
        assertEq(dist.owner(), c.admin, "distributor owner must be the admin");
        assertEq(dist.pendingOwner(), address(0));
        assertEq(dist.merkleSnapshot(), c.snapshot);
        assertEq(dist.feeRecipient(), c.admin, "fee recipient must be the admin, not the deployer");
        assertEq(dist.feePercentage(), 0, "factory convention: no fee at birth");
        assertFalse(dist.allowlistEnabled());

        // The mirror retains no factory privilege either: the one-shot bind is spent.
        vm.expectRevert(TrustAccumulatorMirror.AlreadyBound.selector);
        vm.prank(address(factory));
        TrustAccumulatorMirror(c.mirror).bindSnapshot(address(0xD00D));

        // The directory: exactly one privilege, and not the one that rewrites history.
        assertTrue(registry.hasRole(registry.REGISTRAR_ROLE(), address(factory)));
        assertFalse(registry.hasRole(registry.OPERATOR_ROLE(), address(factory)));
        assertFalse(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), address(factory)));
    }

    function _rolesTouched(Vm.Log[] memory logs) internal pure returns (bytes32[] memory roles) {
        bytes32[] memory found = new bytes32[](logs.length);
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length < 2) continue;
            bytes32 sig = logs[i].topics[0];
            if (
                sig != IAccessControl.RoleGranted.selector && sig != IAccessControl.RoleRevoked.selector
                    && sig != IAccessControl.RoleAdminChanged.selector
            ) continue;
            bytes32 role = logs[i].topics[1];
            bool seen;
            for (uint256 j = 0; j < n; j++) {
                if (found[j] == role) seen = true;
            }
            if (!seen) found[n++] = role;
        }
        roles = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            roles[i] = found[i];
        }
    }

    function _assertHoldsNothing(MerkleSnapshot snapshot, bytes32 role) internal view {
        assertFalse(snapshot.hasRole(role, address(factory)), "factory holds a role on the round");
        assertFalse(snapshot.hasRole(role, address(snapshotDeployer)), "snapshot deployer holds a role");
        assertFalse(snapshot.hasRole(role, address(distributorDeployer)), "distributor deployer holds a role");
        assertFalse(
            snapshot.hasRole(role, address(contributionsControllerDeployer)), "controller deployer holds a role"
        );
    }

    /*//////////////////////////////////////////////////////////////
                       EIP-170 HEADROOM + GAS
    //////////////////////////////////////////////////////////////*/

    function test_Eip170Headroom() public view {
        uint256 factorySize = address(factory).code.length;
        uint256 deployerSize = address(contributionsControllerDeployer).code.length;
        console2.log("ContributionsFactory runtime bytes:", factorySize);
        console2.log("ContributionsParamsControllerDeployer runtime bytes:", deployerSize);
        assertLt(factorySize, 24_576, "factory must fit EIP-170");
        assertLt(deployerSize, 24_576, "controller deployer must fit EIP-170");
        assertGt(24_576 - factorySize, 2_000, "factory runtime margin");
        assertGt(24_576 - deployerSize, 10_000, "controller deployer runtime margin");
    }

    function test_CreateInstanceGasRecorded() public {
        ContributionsFactory.CreateArgs memory args = _args("gas-round");
        vm.prank(parentAdmin);
        uint256 before = gasleft();
        factory.createInstance(args);
        uint256 used = before - gasleft();
        console2.log("createInstance gas:", used);
        // A whole round is seven contracts + three schema registrations; the number is real and
        // recorded honestly in docs/build/contributions/runbook.md. Keep a ceiling so a regression
        // that doubles it fails loudly.
        assertLt(used, 20_000_000, "createInstance gas ceiling");
    }
}
