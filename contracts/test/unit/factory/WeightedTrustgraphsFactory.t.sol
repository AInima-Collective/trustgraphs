// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";

import {SchemaRegistrar} from "src/eas/SchemaRegistrar.sol";
import {EASIndexerResolver} from "src/eas/resolvers/EASIndexerResolver.sol";
import {WeightedPriorParamsController} from "src/factory/WeightedPriorParamsController.sol";
import {WeightedPriorParamsControllerDeployer} from "src/factory/WeightedInstanceDeployers.sol";
import {WeightedTrustgraphsFactory} from "src/factory/WeightedTrustgraphsFactory.sol";
import {MerkleSnapshotDeployer, MerkleFundDistributorDeployer} from "src/factory/InstanceDeployers.sol";
import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {WeightedPriorParamsCodec} from "src/params/WeightedPriorParamsCodec.sol";
import {WeightedPriorValidator} from "src/params/WeightedPriorValidator.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IWeightedPriorParamsController} from "interfaces/factory/IWeightedPriorParamsController.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {MockZkVerifier} from "../../mocks/MockZkVerifier.sol";
import {MockSafeOwner} from "../../helpers/MockSafeOwner.sol";

contract WeightedTrustgraphsFactoryTest is Test {
    uint256 internal constant SCALE = 1e18;
    uint64 internal constant EPOCH_FLOOR = 5;
    uint48 internal constant ACTIVATION_DELAY = 2 days;
    address internal constant REGISTRY_ADMIN = address(0xBE7);

    SchemaRegistry internal schemaRegistry;
    EAS internal eas;
    SchemaRegistrar internal schemaRegistrar;
    MockZkVerifier internal verifier;
    InstanceRegistry internal registry;
    MerkleSnapshotDeployer internal snapshotDeployer;
    MerkleFundDistributorDeployer internal distributorDeployer;
    WeightedPriorParamsControllerDeployer internal controllerDeployer;
    WeightedTrustgraphsFactory internal factory;
    MockSafeOwner internal safeAdmin;

    struct Created {
        bytes32 instanceId;
        address snapshot;
        address resolver;
        address distributor;
        bytes32 schemaUid;
        address controller;
        Vm.Log[] logs;
    }

    struct CreatedEventData {
        string name;
        string metadataURI;
        address resolver;
        bytes32 schemaUid;
        address snapshot;
        address distributor;
        address distributorToken;
        uint64 epochLength;
        bytes32 metadataDigest;
        WeightedPriorParamsCodec.Params params;
    }

    function setUp() public {
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));
        schemaRegistrar = new SchemaRegistrar(ISchemaRegistry(address(schemaRegistry)));
        verifier = new MockZkVerifier();
        registry = new InstanceRegistry(REGISTRY_ADMIN);
        snapshotDeployer = new MerkleSnapshotDeployer();
        distributorDeployer = new MerkleFundDistributorDeployer();
        controllerDeployer = new WeightedPriorParamsControllerDeployer();
        safeAdmin = new MockSafeOwner(address(this), 1);
        factory = new WeightedTrustgraphsFactory(
            IEAS(address(eas)),
            schemaRegistrar,
            IZkVerifier(address(verifier)),
            IInstanceRegistry(address(registry)),
            snapshotDeployer,
            distributorDeployer,
            controllerDeployer,
            EPOCH_FLOOR,
            ACTIVATION_DELAY,
            IProvingVault(address(0))
        );

        bytes32 registrarRole = registry.REGISTRAR_ROLE();
        vm.prank(REGISTRY_ADMIN);
        registry.grantRole(registrarRole, address(factory));
    }

    function test_CreatePublishesWeightedIdentityCommitmentAndRecoveryMetadata() public {
        WeightedTrustgraphsFactory.CreateArgs memory args = _args("weighted network", 3);
        args.admin = address(0xA11CE);
        args.epochLength = 1;
        args.metadataDigest = keccak256("provenance document");
        Created memory created = _create(args);

        IInstanceRegistry.Instance memory record = registry.getInstance(created.instanceId);
        WeightedPriorParamsController controller = WeightedPriorParamsController(created.controller);
        WeightedPriorParamsCodec.Params memory finalParams = controller.getCurrentParams();
        WeightedPriorValidator.Commitment memory prior = _validate(args.manifest);
        CreatedEventData memory eventData = _decodeCreated(created.logs);

        assertEq(record.program, keccak256("trust-graph-weighted"));
        assertEq(record.snapshot, created.snapshot);
        assertEq(record.verifier, address(verifier));
        assertEq(record.registryOrAccumulator, created.resolver);
        assertEq(record.paramsHash, WeightedPriorParamsCodec.hash(finalParams));
        assertEq(MerkleSnapshot(created.snapshot).paramsHash(), record.paramsHash);
        assertEq(finalParams.version, 1);
        assertEq(finalParams.priorRoot, prior.priorRoot);
        assertEq(finalParams.priorCount, prior.priorCount);
        assertEq(finalParams.manifestSha256, sha256(args.manifest));
        assertEq(finalParams.schemaUid, created.schemaUid);
        assertEq(finalParams.accumulator, created.resolver);
        assertEq(finalParams.chainId, block.chainid);
        assertEq(EASIndexerResolver(payable(created.resolver)).boundSchema(), created.schemaUid);
        assertEq(EASIndexerResolver(payable(created.resolver)).snapshot(), created.snapshot);
        assertEq(MerkleSnapshot(created.snapshot).epochLength(), EPOCH_FLOOR);
        assertEq(MerkleSnapshot(created.snapshot).metadataURI(), args.metadataURI);
        assertEq(MerkleSnapshot(created.snapshot).metadataURIHash(), keccak256(bytes(args.metadataURI)));
        assertEq(MerkleSnapshot(created.snapshot).metadataRevision(), 0);
        assertTrue(
            MerkleSnapshot(created.snapshot).provenanceEnabled(),
            "factory mints must open the composition-source window before the first root"
        );
        assertEq(registry.paramsAuthority(created.instanceId), created.controller);
        assertEq(controller.owner(), args.admin);
        assertEq(controller.activationDelay(), ACTIVATION_DELAY);
        assertTrue(controller.versionOnePublished());

        IWeightedPriorParamsController.VersionCommitment memory v1 = controller.versionCommitment(1);
        assertEq(v1.metadataDigest, args.metadataDigest);
        assertEq(v1.manifestSha256, sha256(args.manifest));
        assertEq(v1.paramsHash, record.paramsHash);
        assertEq(eventData.name, args.name);
        assertEq(eventData.metadataURI, args.metadataURI);
        assertEq(eventData.metadataDigest, args.metadataDigest);
        assertEq(eventData.resolver, created.resolver);
        assertEq(eventData.snapshot, created.snapshot);
        assertEq(WeightedPriorParamsCodec.hash(eventData.params), record.paramsHash);

        (uint256 createdLog, uint256 controllerLog, uint256 initialLog) = _discoveryLogOrder(created);
        assertLt(createdLog, controllerLog, "instance event precedes controller discovery");
        assertLt(controllerLog, initialLog, "controller discovery precedes V1 publication");
    }

    function test_FactoryAndDeployersAreInertAfterCreation() public {
        WeightedTrustgraphsFactory.CreateArgs memory args = _args("inert weighted", 2);
        args.withDistributor = true;
        args.admin = address(safeAdmin);
        Created memory created = _create(args);
        MerkleSnapshot snapshot = MerkleSnapshot(created.snapshot);

        assertFalse(snapshot.hasRole(snapshot.OPERATIONAL_ROLE(), address(factory)));
        assertFalse(snapshot.hasRole(snapshot.CONSTITUTIONAL_ROLE(), address(factory)));
        assertFalse(snapshot.hasRole(snapshot.OPERATIONAL_ROLE(), address(snapshotDeployer)));
        assertFalse(snapshot.hasRole(snapshot.OPERATIONAL_ROLE(), address(controllerDeployer)));
        assertTrue(snapshot.hasRole(snapshot.OPERATIONAL_ROLE(), created.controller));
        assertTrue(snapshot.hasRole(snapshot.CONSTITUTIONAL_ROLE(), args.admin));
        assertEq(registry.paramsAuthority(created.instanceId), created.controller);
        assertNotEq(created.distributor, address(0));
    }

    function test_CreatedControllerRotatesOnlyAfterValidatedTimelock() public {
        WeightedTrustgraphsFactory.CreateArgs memory args = _args("rotating weighted", 3);
        args.admin = address(0xA11CE);
        Created memory created = _create(args);
        WeightedPriorParamsController controller = WeightedPriorParamsController(created.controller);
        bytes32 oldHash = controller.currentParamsHash();
        bytes memory nextManifest = _manifest(7, uint64(block.chainid), 9);

        vm.prank(args.admin);
        controller.proposePrior(nextManifest, keccak256("v2 provenance"));
        assertEq(MerkleSnapshot(created.snapshot).paramsHash(), oldHash);
        vm.warp(block.timestamp + ACTIVATION_DELAY);
        controller.activatePrior(2);
        assertNotEq(controller.currentParamsHash(), oldHash);
        assertEq(controller.currentParamsHash(), MerkleSnapshot(created.snapshot).paramsHash());
        assertEq(controller.currentParamsHash(), registry.getInstance(created.instanceId).paramsHash);
    }

    function test_RejectsMalformedAbsentWrongChainAndPrecommittedCreation() public {
        WeightedTrustgraphsFactory.CreateArgs memory args = _args("bad weighted", 2);
        args.manifest = "";
        vm.expectPartialRevert(WeightedPriorValidator.InvalidManifestLength.selector);
        factory.createInstance(args);

        args = _args("bad weighted", 2);
        args.manifest = _manifest(2, uint64(block.chainid + 1), 1);
        vm.expectPartialRevert(WeightedPriorValidator.InvalidManifestChain.selector);
        factory.createInstance(args);

        args = _args("bad weighted", 2);
        for (uint256 i; i < 20; ++i) {
            args.manifest[46 + i] = args.manifest[18 + i];
        }
        vm.expectPartialRevert(WeightedPriorValidator.PriorAccountsNotAscending.selector);
        factory.createInstance(args);

        args = _args("bad weighted", 2);
        args.params.priorRoot = keccak256("caller-supplied root");
        vm.expectRevert(WeightedPriorValidator.DerivedFieldNotZero.selector);
        factory.createInstance(args);
    }

    function test_Max2048ManifestCanCreateAndRemainsCommitmentOnly() public {
        WeightedTrustgraphsFactory.CreateArgs memory args = _args("maximum weighted", 2048);
        Created memory created = _create(args);
        WeightedPriorParamsController controller = WeightedPriorParamsController(created.controller);
        WeightedPriorParamsCodec.Params memory params = controller.getCurrentParams();

        assertEq(params.priorCount, 2048);
        assertEq(params.manifestSha256, sha256(args.manifest));
        assertEq(controller.getPendingPrior().version, 0);
        assertEq(controller.versionCommitment(1).priorCount, 2048);
    }

    function test_AttachDistributorDeploysAFundOwnedByTheVerifiedAuthority() public {
        WeightedTrustgraphsFactory.CreateArgs memory args = _args("fundless weighted", 2);
        args.admin = address(safeAdmin);
        Created memory created = _create(args);
        assertEq(created.distributor, address(0), "created without a fund");

        vm.prank(address(0x57AA));
        address distributor = factory.attachDistributor(created.instanceId, args.admin, address(0));
        assertEq(MerkleFundDistributor(payable(distributor)).owner(), args.admin, "fund owner is the authority");
        assertEq(MerkleFundDistributor(payable(distributor)).merkleSnapshot(), created.snapshot);
        assertEq(factory.distributorOf(created.instanceId), distributor);

        vm.expectRevert(
            abi.encodeWithSelector(
                WeightedTrustgraphsFactory.DistributorAlreadyAttached.selector, created.instanceId, distributor
            )
        );
        factory.attachDistributor(created.instanceId, args.admin, address(0));

        WeightedTrustgraphsFactory.CreateArgs memory second = _args("gated weighted", 2);
        second.admin = args.admin;
        Created memory again = _create(second);
        vm.expectRevert(
            abi.encodeWithSelector(
                WeightedTrustgraphsFactory.NotInstanceAuthority.selector, again.instanceId, address(0x57AA)
            )
        );
        factory.attachDistributor(again.instanceId, address(0x57AA), address(0));
    }

    function test_DistributorCreationAndAttachmentRejectEoaOwners() public {
        address eoa = address(0xE0A);
        WeightedTrustgraphsFactory.CreateArgs memory funded = _args("unsafe weighted", 2);
        funded.admin = eoa;
        funded.withDistributor = true;
        vm.expectRevert(abi.encodeWithSelector(WeightedTrustgraphsFactory.InvalidDistributorSafe.selector, eoa));
        factory.createInstance(funded);

        WeightedTrustgraphsFactory.CreateArgs memory fundless = _args("unsafe weighted attach", 2);
        fundless.admin = eoa;
        Created memory created = _create(fundless);
        vm.expectRevert(abi.encodeWithSelector(WeightedTrustgraphsFactory.InvalidDistributorSafe.selector, eoa));
        factory.attachDistributor(created.instanceId, eoa, address(0));
    }

    function test_WeightedContractsHaveExplicitEip170Headroom() public view {
        assertLt(address(factory).code.length, 24_576);
        assertLt(address(controllerDeployer).code.length, 24_576);
        assertGt(24_576 - address(factory).code.length, 10_000, "factory runtime margin");
        assertGt(24_576 - address(controllerDeployer).code.length, 10_000, "deployer runtime margin");
    }

    function _create(WeightedTrustgraphsFactory.CreateArgs memory args) internal returns (Created memory created) {
        vm.recordLogs();
        (created.instanceId, created.snapshot, created.resolver, created.distributor, created.schemaUid) =
            factory.createInstance(args);
        created.logs = vm.getRecordedLogs();
        for (uint256 i; i < created.logs.length; ++i) {
            Vm.Log memory entry = created.logs[i];
            if (
                entry.emitter == address(factory) && entry.topics.length == 3
                    && entry.topics[0] == WeightedTrustgraphsFactory.WeightedParamsControllerCreated.selector
                    && entry.topics[1] == created.instanceId
            ) {
                created.controller = address(uint160(uint256(entry.topics[2])));
                break;
            }
        }
        assertNotEq(created.controller, address(0), "controller discovery event");
    }

    function _decodeCreated(Vm.Log[] memory logs) internal view returns (CreatedEventData memory eventData) {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory entry = logs[i];
            if (
                entry.emitter != address(factory) || entry.topics.length != 4
                    || entry.topics[0] != WeightedTrustgraphsFactory.WeightedInstanceCreated.selector
            ) continue;
            (
                eventData.name,
                eventData.metadataURI,
                eventData.resolver,
                eventData.schemaUid,
                eventData.snapshot,
                eventData.distributor,
                eventData.distributorToken,
                eventData.epochLength,
                eventData.metadataDigest,
                eventData.params
            ) =
                abi.decode(
                    entry.data,
                    (
                        string,
                        string,
                        address,
                        bytes32,
                        address,
                        address,
                        address,
                        uint64,
                        bytes32,
                        WeightedPriorParamsCodec.Params
                    )
                );
            return eventData;
        }
        revert("WeightedInstanceCreated was not emitted");
    }

    function _discoveryLogOrder(Created memory created)
        internal
        view
        returns (uint256 createdLog, uint256 controllerLog, uint256 initialLog)
    {
        createdLog = type(uint256).max;
        controllerLog = type(uint256).max;
        initialLog = type(uint256).max;
        for (uint256 i; i < created.logs.length; ++i) {
            Vm.Log memory entry = created.logs[i];
            if (entry.topics.length == 0) continue;
            if (
                entry.emitter == address(factory)
                    && entry.topics[0] == WeightedTrustgraphsFactory.WeightedInstanceCreated.selector
            ) createdLog = i;
            if (
                entry.emitter == address(factory)
                    && entry.topics[0] == WeightedTrustgraphsFactory.WeightedParamsControllerCreated.selector
            ) controllerLog = i;
            if (
                entry.emitter == created.controller
                    && entry.topics[0] == IWeightedPriorParamsController.InitialPriorPublished.selector
            ) initialLog = i;
        }
        assertTrue(createdLog != type(uint256).max);
        assertTrue(controllerLog != type(uint256).max);
        assertTrue(initialLog != type(uint256).max);
    }

    function _args(string memory name, uint256 count)
        internal
        view
        returns (WeightedTrustgraphsFactory.CreateArgs memory args)
    {
        args.name = name;
        args.metadataURI = "ipfs://weighted-network-metadata";
        args.params.version = 1;
        args.params.dampingFp = 85e16;
        args.params.toleranceFp = 1e12;
        args.params.maxIterations = 40;
        args.params.minWeight = 0;
        args.params.maxWeight = 100;
        args.params.weightFieldIndex = 1;
        args.manifest = _manifest(count, uint64(block.chainid), 1);
        args.epochLength = EPOCH_FLOOR;
    }

    function _validate(bytes memory manifest) internal view returns (WeightedPriorValidator.Commitment memory) {
        return WeightedPriorValidator.validateManifestMemory(manifest, uint64(block.chainid));
    }

    function _manifest(uint256 count, uint64 chainId, uint64 salt) internal pure returns (bytes memory manifest) {
        manifest = new bytes(18 + count * 28);
        manifest[0] = 0x54;
        manifest[1] = 0x47;
        manifest[2] = 0x57;
        manifest[3] = 0x50;
        manifest[5] = 0x01;
        _writeBigEndian(manifest, 6, chainId, 8);
        _writeBigEndian(manifest, 14, count, 4);

        uint256 base = SCALE / count;
        uint256 remainder = SCALE % count;
        for (uint256 i; i < count; ++i) {
            uint256 offset = 18 + i * 28;
            address account = address(uint160(i + 1));
            uint256 weight = base + (i < remainder ? 1 : 0);
            if (i == 0 && count > 1 && salt % 2 == 1) weight += 1;
            if (i == count - 1 && count > 1 && salt % 2 == 1) weight -= 1;
            assembly ("memory-safe") {
                mstore(add(add(manifest, 32), offset), shl(96, account))
                mstore(add(add(add(manifest, 32), offset), 20), shl(192, weight))
            }
        }
    }

    function _writeBigEndian(bytes memory target, uint256 offset, uint256 value, uint256 width) internal pure {
        for (uint256 i; i < width; ++i) {
            target[offset + width - i - 1] = bytes1(uint8(value));
            value >>= 8;
        }
    }
}
