// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {CompositionSourceAdapter, CompositionSourceAdapterFactory} from "src/composition/CompositionSourceAdapter.sol";
import {CompositionSourceAccumulator} from "src/composition/CompositionSourceAccumulator.sol";
import {TrustComposeFactory} from "src/factory/TrustComposeFactory.sol";
import {TrustComposeParamsController} from "src/factory/TrustComposeParamsController.sol";
import {
    CompositionSourceAccumulatorDeployer,
    TrustComposeParamsControllerDeployer
} from "src/factory/TrustComposeInstanceDeployers.sol";
import {MerkleSnapshotDeployer, MerkleFundDistributorDeployer} from "src/factory/InstanceDeployers.sol";
import {DistributorAttaching} from "src/factory/DistributorAttaching.sol";
import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {TrustComposeParamsCodec} from "src/params/TrustComposeParamsCodec.sol";
import {TrustComposeValidator} from "src/params/TrustComposeValidator.sol";
import {ICompositionSourceAdapter} from "interfaces/composition/ICompositionSourceAdapter.sol";
import {ITrustComposeParamsController} from "interfaces/factory/ITrustComposeParamsController.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleSnapshotProvenance} from "interfaces/merkle/IMerkleSnapshotProvenance.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {MockAccumulator} from "../../mocks/MockAccumulator.sol";
import {MockSafeOwner} from "../../helpers/MockSafeOwner.sol";

contract CompositionProgramVerifier is IZkVerifier {
    bytes32 public immutable programVKey;

    constructor(bytes32 programVKey_) {
        programVKey = programVKey_;
    }

    function verify(bytes calldata, bytes32) external pure {}
}

contract UnauthenticatedAdapterLookalike {
    function sourceId() external pure returns (bytes32) {
        return bytes32(uint256(1));
    }
}

/// @notice The full capture battery, including the mixed-source behavior:
///         one standard `trust-graph` source and one `trust-graph-weighted` source in a single
///         composition, each keeping its real program and output domain in the frozen TGCM bytes.
contract TrustComposeCaptureTest is Test {
    uint64 internal constant SCALE = 1e18;
    uint48 internal constant DELAY = 2 days;
    uint64 internal constant MAX_AGE = 500;
    bytes32 internal constant COMPOSE_VKEY = keccak256("composition vkey");
    bytes32 internal constant SOURCE_VKEY = keccak256("source vkey");
    bytes32 internal constant FAMILY = keccak256("weighted-allocation-v1");
    bytes32 internal constant OUTPUT_KIND = keccak256("allocation");
    address internal constant NEW_OWNER = address(0xA11CE);

    InstanceRegistry internal registry;
    CompositionSourceAdapterFactory internal adapterFactory;
    CompositionProgramVerifier internal sourceVerifier;
    CompositionProgramVerifier internal composeVerifier;
    TrustComposeFactory internal factory;

    MerkleSnapshot[] internal sourceSnapshots;
    MockAccumulator[] internal sourceAccumulators;
    address[] internal sourceAdapters;

    function setUp() public {
        registry = new InstanceRegistry(address(this));
        adapterFactory = new CompositionSourceAdapterFactory(registry);
        sourceVerifier = new CompositionProgramVerifier(SOURCE_VKEY);
        composeVerifier = new CompositionProgramVerifier(COMPOSE_VKEY);
        factory = new TrustComposeFactory(
            composeVerifier,
            COMPOSE_VKEY,
            registry,
            adapterFactory,
            new MerkleSnapshotDeployer(),
            new MerkleFundDistributorDeployer(),
            new CompositionSourceAccumulatorDeployer(),
            new TrustComposeParamsControllerDeployer(),
            3,
            DELAY,
            IProvingVault(address(0))
        );
        registry.grantRole(registry.REGISTRAR_ROLE(), address(factory));
    }

    /// @dev Even indices register the standard program; odd indices the weighted program, so every
    ///      two-source composition below is genuinely mixed.
    function _sourceProgram(uint256 index) internal pure returns (bytes32) {
        return index % 2 == 0
            ? TrustComposeValidator.TRUST_GRAPH_PROGRAM_ID
            : TrustComposeValidator.WEIGHTED_TRUST_GRAPH_PROGRAM_ID;
    }

    function test_MixedCreationFreezesBothRealProgramsAndDerivedDomains() public {
        _createSources(2, true);
        (bytes32 instanceId, MerkleSnapshot snapshot, CompositionSourceAccumulator accumulator,) =
            _createComposition(2, MAX_AGE);

        vm.roll(100);
        uint256 checkpoint = snapshot.trigger();
        bytes memory frozen = accumulator.getCaptureManifest(checkpoint);
        assertEq(frozen.length, 23 + 2 * 293);
        assertEq(bytes4(uint32(_readUint(frozen, 0, 4))), bytes4("TGCM"));
        assertEq(_readUint(frozen, 4, 2), 1, "manifest version is 1");
        assertEq(_readUint(frozen, 6, 8), block.chainid);
        assertEq(_readUint(frozen, 14, 8), 100);
        assertEq(_readUint(frozen, 22, 1), 2);

        // Each record retains its real program and its program-derived output domain — the
        // standard source is never relabelled to the weighted identity or vice versa.
        assertEq(bytes32(_readUint(frozen, 23 + 84, 32)), TrustComposeValidator.TRUST_GRAPH_PROGRAM_ID);
        assertEq(bytes32(_readUint(frozen, 23 + 116, 32)), TrustComposeValidator.TRUST_GRAPH_OUTPUT_DOMAIN);
        assertEq(bytes32(_readUint(frozen, 23 + 293 + 84, 32)), TrustComposeValidator.WEIGHTED_TRUST_GRAPH_PROGRAM_ID);
        assertEq(
            bytes32(_readUint(frozen, 23 + 293 + 116, 32)), TrustComposeValidator.WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN
        );

        assertEq(accumulator.getCheckpoint(checkpoint).acc, sha256(frozen));
        assertEq(accumulator.getCheckpoint(checkpoint).leafCount, 2);
        assertEq(accumulator.checkpointPolicyVersion(checkpoint), 1);
        assertEq(accumulator.checkpointAdapterSetHash(checkpoint), accumulator.adapterSetHash());
        uint256[] memory sourceCheckpointIds = accumulator.getCaptureSourceCheckpointIds(checkpoint);
        assertEq(sourceCheckpointIds.length, 2);
        assertEq(sourceCheckpointIds[0], 0);
        assertEq(sourceCheckpointIds[1], 0);

        IInstanceRegistry.Instance memory record = registry.getInstance(instanceId);
        assertEq(record.program, keccak256("trust-compose"), "the composition program ID");
        assertEq(record.verifier, address(composeVerifier));
        assertEq(record.snapshot, address(snapshot));
        assertEq(record.registryOrAccumulator, address(accumulator));
    }

    function test_AtomicCaptureIsImmutableAndPreservesUnchangedSources() public {
        _createSources(2, true);
        (, MerkleSnapshot snapshot, CompositionSourceAccumulator accumulator,) = _createComposition(2, MAX_AGE);

        vm.roll(100);
        uint256 checkpoint = snapshot.trigger();
        bytes memory frozen = accumulator.getCaptureManifest(checkpoint);
        assertEq(_readUint(frozen, 23 + 148, 8), 0, "source zero state index");
        assertEq(_readUint(frozen, 23 + 293 + 148, 8), 0, "unchanged source state index");

        bytes32 frozenHash = keccak256(frozen);
        _updateSource(0, 105, keccak256("updated root"), 2_000);
        assertEq(keccak256(accumulator.getCaptureManifest(checkpoint)), frozenHash, "checkpoint is immutable");

        vm.roll(110);
        uint256 laterCheckpoint = snapshot.trigger();
        bytes memory later = accumulator.getCaptureManifest(laterCheckpoint);
        assertEq(_readUint(later, 14, 8), 110, "new atomic capture block");
        assertEq(_readUint(later, 23 + 148, 8), 1, "updated source advances");
        assertEq(_readUint(later, 23 + 293 + 148, 8), 0, "unchanged source remains exact");
        assertNotEq(sha256(later), sha256(frozen));
    }

    function test_ForeignAndNarrowPolicyManifestBytesAreRejectedNotReinterpreted() public {
        _createSources(2, true);

        // A foreign manifest version word is a version error, never a layout guess.
        bytes memory foreignVersion = _policyManifest(2, MAX_AGE, false);
        foreignVersion[5] = bytes1(uint8(2));
        TrustComposeFactory.CreateArgs memory args;
        args.name = "foreign-version-word";
        args.params = _params(MAX_AGE);
        args.policyManifest = foreignVersion;
        args.sourceAdapters = _adapterSlice(2);
        args.epochLength = 3;
        vm.expectRevert(abi.encodeWithSelector(TrustComposeValidator.InvalidManifestVersion.selector, uint16(2)));
        factory.createInstance(args);

        // Records without the per-source output-domain word (the narrower 133-byte layout) are a
        // length error under the real version, never reinterpreted by shape.
        bytes memory narrow = abi.encodePacked(bytes4("TGCP"), uint16(1), uint64(block.chainid), uint8(2));
        for (uint256 i; i < 2; ++i) {
            CompositionSourceAdapter adapter = CompositionSourceAdapter(sourceAdapters[i]);
            narrow = bytes.concat(
                narrow,
                abi.encodePacked(
                    adapter.sourceId(),
                    adapter.snapshot(),
                    adapter.familyId(),
                    adapter.programId(),
                    uint64(SCALE / 2),
                    MAX_AGE,
                    uint8(1)
                )
            );
        }
        args.name = "narrow-records";
        args.policyManifest = narrow;
        vm.expectRevert(
            abi.encodeWithSelector(TrustComposeValidator.InvalidManifestLength.selector, narrow.length, 15 + 2 * 165)
        );
        factory.createInstance(args);
    }

    function test_CrossedOutputDomainsFailClosedAtCreation() public {
        _createSources(2, true);
        bytes memory crossed = _policyManifestWithDomains(
            MAX_AGE,
            TrustComposeValidator.WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN,
            TrustComposeValidator.TRUST_GRAPH_OUTPUT_DOMAIN
        );
        TrustComposeFactory.CreateArgs memory args;
        args.name = "crossed-domains";
        args.params = _params(MAX_AGE);
        args.policyManifest = crossed;
        args.sourceAdapters = _adapterSlice(2);
        args.epochLength = 3;
        vm.expectPartialRevert(TrustComposeValidator.WrongSourceOutputDomain.selector);
        factory.createInstance(args);
    }

    function test_UnadmittedThirdProgramSourceFailsClosedAtCreation() public {
        _createSources(2, true);
        _createSourceWithProgram(2, keccak256("contributions"));
        bytes memory manifest = abi.encodePacked(bytes4("TGCP"), uint16(1), uint64(block.chainid), uint8(3));
        uint64[3] memory weights = [uint64(35e16), uint64(55e16), uint64(10e16)];
        bytes32[3] memory domains = [
            TrustComposeValidator.TRUST_GRAPH_OUTPUT_DOMAIN,
            TrustComposeValidator.WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN,
            keccak256("trustgraphs.output.contributions-recipient.v1")
        ];
        for (uint256 i; i < 3; ++i) {
            CompositionSourceAdapter adapter = CompositionSourceAdapter(sourceAdapters[i]);
            manifest = bytes.concat(
                manifest,
                abi.encodePacked(
                    adapter.sourceId(),
                    adapter.snapshot(),
                    adapter.familyId(),
                    adapter.programId(),
                    domains[i],
                    weights[i],
                    MAX_AGE,
                    uint8(1)
                )
            );
        }
        TrustComposeFactory.CreateArgs memory args;
        args.name = "unadmitted-third-program";
        args.params = _params(MAX_AGE);
        args.policyManifest = manifest;
        args.sourceAdapters = _adapterSlice(3);
        args.epochLength = 3;
        vm.expectRevert(
            abi.encodeWithSelector(
                TrustComposeValidator.UnadmittedSourceProgram.selector, uint8(2), keccak256("contributions")
            )
        );
        factory.createInstance(args);
    }

    function test_UnavailableSourcesFailClosedAtPreflight() public {
        _createSources(2, false);
        (, MerkleSnapshot unavailableSnapshot,,) = _createComposition(2, MAX_AGE);
        vm.roll(100);
        vm.expectRevert(CompositionSourceAdapter.SourceUnavailable.selector);
        unavailableSnapshot.trigger();
    }

    function test_StaleSourcesFailClosedAtPreflight() public {
        _createSources(2, true);
        (, MerkleSnapshot staleSnapshot,,) = _createComposition(2, 5);
        vm.roll(100);
        vm.expectPartialRevert(CompositionSourceAccumulator.StaleSource.selector);
        staleSnapshot.trigger();
    }

    function test_ControllerRotationAndUnreviewedLookalikeFailClosed() public {
        _createSources(2, true);
        (bytes32 instanceId, MerkleSnapshot snapshot,, bytes memory manifest) = _createComposition(2, MAX_AGE);
        TrustComposeParamsController controller = TrustComposeParamsController(registry.paramsAuthority(instanceId));

        address[] memory lookalikes = _adapterSlice(2);
        lookalikes[0] = address(new UnauthenticatedAdapterLookalike());
        vm.expectPartialRevert(CompositionSourceAccumulator.UnauthenticatedAdapter.selector);
        controller.proposePolicy(manifest, lookalikes, keccak256("unreviewed"));

        registry.setParamsAuthority(bytes32(uint256(1)), NEW_OWNER);
        vm.roll(100);
        vm.expectRevert(CompositionSourceAdapter.RegistryRecordChanged.selector);
        snapshot.trigger();
    }

    function test_TimelockCancelActivateRollbackAndTwoStepAuthorityTransfer() public {
        _createSources(2, true);
        (
            bytes32 instanceId,
            MerkleSnapshot snapshot,
            CompositionSourceAccumulator accumulator,
            bytes memory initial
        ) = _createComposition(2, MAX_AGE);
        TrustComposeParamsController controller = TrustComposeParamsController(registry.paramsAuthority(instanceId));
        bytes32 initialHash = controller.currentParamsHash();
        bytes memory rotated = _policyManifest(2, MAX_AGE, true);
        address[] memory adapters = _adapterSlice(2);

        (uint64 cancelledVersion,,) = controller.proposePolicy(rotated, adapters, keccak256("cancelled"));
        vm.expectPartialRevert(TrustComposeParamsController.ActivationDelayNotElapsed.selector);
        controller.activatePolicy(cancelledVersion, rotated, adapters);
        controller.cancelPolicy();
        assertEq(
            uint8(controller.versionCommitment(cancelledVersion).status),
            uint8(ITrustComposeParamsController.ProposalStatus.Cancelled)
        );

        (uint64 activeVersion,, uint48 readyAt) = controller.proposePolicy(rotated, adapters, keccak256("v3"));
        assertEq(activeVersion, cancelledVersion + 1, "cancelled version is never reused");
        vm.warp(readyAt);
        controller.activatePolicy(activeVersion, rotated, adapters);
        bytes32 rotatedHash = controller.currentParamsHash();
        assertNotEq(rotatedHash, initialHash);
        assertEq(accumulator.policyVersion(), activeVersion);
        assertEq(snapshot.paramsHash(), rotatedHash);
        assertEq(registry.getInstance(instanceId).paramsHash, rotatedHash);

        (uint64 rollbackVersion,, uint48 rollbackAt) =
            controller.proposePolicy(initial, adapters, keccak256("rollback-to-v1"));
        vm.warp(rollbackAt);
        controller.activatePolicy(rollbackVersion, initial, adapters);
        assertEq(controller.currentParamsHash(), initialHash, "full policy rollback");

        controller.transferOwnership(NEW_OWNER);
        vm.prank(NEW_OWNER);
        controller.acceptOwnership();
        assertEq(controller.owner(), NEW_OWNER);
        vm.expectRevert();
        controller.proposePolicy(rotated, adapters, keccak256("old authority"));
    }

    function test_AuthenticatedAdapterRecoveryAdvancesHistoryWithoutChangingGuestParams() public {
        _createSources(2, true);
        (bytes32 instanceId,, CompositionSourceAccumulator accumulator, bytes memory manifest) =
            _createComposition(2, MAX_AGE);
        TrustComposeParamsController controller = TrustComposeParamsController(registry.paramsAuthority(instanceId));
        bytes32 paramsHash = controller.currentParamsHash();

        CompositionSourceAdapter replacement = adapterFactory.create(
            registry,
            bytes32(uint256(1)),
            bytes32(uint256(1)),
            FAMILY,
            OUTPUT_KIND,
            keccak256("reviewed replacement provenance")
        );
        address[] memory recovered = _adapterSlice(2);
        recovered[0] = address(replacement);
        (uint64 recoveryVersion,, uint48 readyAt) =
            controller.proposePolicy(manifest, recovered, keccak256("adapter recovery review"));
        vm.warp(readyAt);
        controller.activatePolicy(recoveryVersion, manifest, recovered);

        (address activeAdapter,,) = accumulator.policyAt(0);
        assertEq(activeAdapter, address(replacement));
        assertEq(controller.currentParamsHash(), paramsHash, "TGCP bytes did not change");
        assertEq(registry.getInstance(instanceId).paramsHash, paramsHash);
        assertEq(
            uint8(controller.versionCommitment(recoveryVersion).status),
            uint8(ITrustComposeParamsController.ProposalStatus.Activated)
        );
    }

    function test_GasBoundedAtTwoAndEightSources() public {
        _createSources(8, true);
        (, MerkleSnapshot two,,) = _createComposition(2, MAX_AGE);
        vm.roll(100);
        uint256 beforeTwo = gasleft();
        two.trigger();
        uint256 twoGas = beforeTwo - gasleft();

        (, MerkleSnapshot eight,,) = _createComposition(8, MAX_AGE);
        vm.roll(104);
        uint256 beforeEight = gasleft();
        eight.trigger();
        uint256 eightGas = beforeEight - gasleft();
        emit log_named_uint("trust-compose trigger gas (2 sources)", twoGas);
        emit log_named_uint("trust-compose trigger gas (8 sources)", eightGas);
        assertLt(twoGas, 3_500_000);
        assertLt(eightGas, 9_000_000);
        assertGt(eightGas, twoGas);
    }

    function test_FactoryAndDeployersRetainNoAuthorityAndHaveEip170Headroom() public {
        _createSources(2, true);
        (bytes32 instanceId, MerkleSnapshot snapshot, CompositionSourceAccumulator accumulator,) =
            _createComposition(2, MAX_AGE);
        address controller = registry.paramsAuthority(instanceId);
        assertFalse(snapshot.hasRole(snapshot.CONSTITUTIONAL_ROLE(), address(factory)));
        assertFalse(snapshot.hasRole(snapshot.OPERATIONAL_ROLE(), address(factory)));
        assertTrue(snapshot.hasRole(snapshot.CONSTITUTIONAL_ROLE(), address(this)));
        assertTrue(snapshot.hasRole(snapshot.OPERATIONAL_ROLE(), controller));
        assertTrue(snapshot.provenanceEnabled(), "composition accepted-state provenance is mandatory");
        assertEq(accumulator.binder(), address(factory));
        assertEq(accumulator.controller(), controller);
        assertLt(address(factory).code.length, 24_576);
        assertLt(address(factory.PARAMS_CONTROLLER_DEPLOYER()).code.length, 24_576);
        assertLt(address(factory.ACCUMULATOR_DEPLOYER()).code.length, 24_576);
        // The controller embeds the closed compatibility-class constants, which costs a few
        // dozen bytes over the V1 margin convention. If this margin ever gets tight, the escape
        // hatch is compiling the validator as an external library, not deleting checks.
        assertGt(
            24_576 - address(factory.PARAMS_CONTROLLER_DEPLOYER()).code.length,
            2_500,
            "controller deployer runtime margin"
        );
    }

    function test_ComposeFactoryRejectsAnAdapterFactoryPinnedToAnotherRegistry() public {
        InstanceRegistry foreignRegistry = new InstanceRegistry(address(this));
        CompositionSourceAdapterFactory foreignAdapterFactory = new CompositionSourceAdapterFactory(foreignRegistry);
        MerkleSnapshotDeployer snapshotDeployer = new MerkleSnapshotDeployer();
        MerkleFundDistributorDeployer distributorDeployer = new MerkleFundDistributorDeployer();
        CompositionSourceAccumulatorDeployer accumulatorDeployer = new CompositionSourceAccumulatorDeployer();
        TrustComposeParamsControllerDeployer paramsControllerDeployer = new TrustComposeParamsControllerDeployer();

        vm.expectRevert(
            abi.encodeWithSelector(
                TrustComposeFactory.SourceAdapterRegistryMismatch.selector, address(registry), address(foreignRegistry)
            )
        );
        new TrustComposeFactory(
            composeVerifier,
            COMPOSE_VKEY,
            registry,
            foreignAdapterFactory,
            snapshotDeployer,
            distributorDeployer,
            accumulatorDeployer,
            paramsControllerDeployer,
            3,
            DELAY,
            IProvingVault(address(0))
        );
    }

    function test_SourceProvenanceBindsCheckpointParamsVerifierVkeyAndAcceptanceBlock() public {
        _createSources(2, true);
        CompositionSourceAdapter adapter = CompositionSourceAdapter(sourceAdapters[0]);
        ICompositionSourceAdapter.CapturedState memory captured = adapter.readLatest();
        IMerkleSnapshot.MerkleState memory state = sourceSnapshots[0].getStateAtIndex(0);
        IMerkleSnapshotProvenance.StateProvenance memory provenance = sourceSnapshots[0].getStateProvenance(0);

        assertEq(captured.stateIndex, 0);
        assertEq(captured.freezeBlock, state.blockNumber);
        assertEq(captured.outputRoot, state.root);
        assertEq(captured.blobSha256, state.ipfsHash);
        assertEq(captured.cidDigest, keccak256(bytes(state.ipfsHashCid)));
        assertEq(captured.checkpointId, provenance.checkpointId);
        assertEq(captured.acceptedAtBlock, provenance.acceptedAtBlock);
        assertEq(captured.paramsHash, provenance.paramsHash);
        assertEq(captured.verifier, address(sourceVerifier));
        assertEq(captured.verifierCodehash, address(sourceVerifier).codehash);
        assertEq(captured.programVKey, SOURCE_VKEY);

        _updateSource(0, 30, keccak256("later root"), 2_000);
        ICompositionSourceAdapter.CapturedState memory historical = adapter.readAt(0);
        assertEq(historical.outputRoot, captured.outputRoot, "historical provenance remains recoverable");
        assertEq(historical.paramsHash, captured.paramsHash);
        ICompositionSourceAdapter.CapturedState memory byCheckpoint = adapter.readCheckpoint(captured.checkpointId);
        assertEq(byCheckpoint.outputRoot, captured.outputRoot);
        assertEq(byCheckpoint.stateIndex, captured.stateIndex);
    }

    function test_ProvenanceIsExplicitOneWayPreStateOptIn() public {
        MockAccumulator sourceAccumulator = new MockAccumulator();
        MerkleSnapshot sourceSnapshot = new MerkleSnapshot(
            sourceVerifier, keccak256("legacy params"), sourceAccumulator, address(this), address(this), ""
        );
        registry.registerWithParamsAuthority(
            bytes32(uint256(99)),
            IInstanceRegistry.Instance({
                program: TrustComposeValidator.TRUST_GRAPH_PROGRAM_ID,
                snapshot: address(sourceSnapshot),
                verifier: address(sourceVerifier),
                registryOrAccumulator: address(sourceAccumulator),
                paramsHash: sourceSnapshot.paramsHash()
            }),
            address(this)
        );
        vm.expectRevert(CompositionSourceAdapter.ProvenanceDisabled.selector);
        adapterFactory.create(
            registry, bytes32(uint256(99)), bytes32(uint256(99)), FAMILY, OUTPUT_KIND, keccak256("legacy provenance")
        );

        sourceAccumulator.setState(keccak256("legacy acc"), 1);
        uint256 checkpoint = sourceSnapshot.trigger();
        sourceSnapshot.submitProof(
            checkpoint,
            keccak256("legacy root"),
            sha256("legacy blob"),
            "bafk-legacy",
            1_000,
            bytes32(0),
            address(0),
            ""
        );
        assertFalse(sourceSnapshot.provenanceEnabled());
        vm.expectPartialRevert(IMerkleSnapshotProvenance.ProvenanceEnableAfterState.selector);
        sourceSnapshot.enableStateProvenance();
        vm.expectPartialRevert(IMerkleSnapshot.UnpinnedCheckpoint.selector);
        sourceSnapshot.getAcceptedCheckpoint(checkpoint);
    }

    function test_SameBlockSourceReplacementCannotEraseCapturedCheckpointHistory() public {
        _createSources(2, true);
        (, MerkleSnapshot compositionSnapshot, CompositionSourceAccumulator accumulator,) =
            _createComposition(2, MAX_AGE);
        CompositionSourceAdapter adapter = CompositionSourceAdapter(sourceAdapters[0]);

        _updateSource(0, 13, keccak256("same-block A"), 2_000);
        ICompositionSourceAdapter.CapturedState memory sourceA = adapter.readLatest();
        uint256 compositionCheckpoint = compositionSnapshot.trigger();
        _updateSource(0, 13, keccak256("same-block B"), 3_000);

        ICompositionSourceAdapter.CapturedState memory legacySlotNowB = adapter.readAt(sourceA.stateIndex);
        assertNotEq(legacySlotNowB.outputRoot, sourceA.outputRoot, "legacy block slot was replaced");
        uint256[] memory sourceCheckpointIds = accumulator.getCaptureSourceCheckpointIds(compositionCheckpoint);
        ICompositionSourceAdapter.CapturedState memory recoveredA = adapter.readCheckpoint(sourceCheckpointIds[0]);
        assertEq(recoveredA.outputRoot, sourceA.outputRoot, "checkpoint history retains A");
        assertEq(recoveredA.paramsHash, sourceA.paramsHash);
    }

    function test_EmptyAndOverflowSourceOutputsFailClosed() public {
        _createSources(2, true);
        _updateSource(0, 30, bytes32(0), 1);
        vm.expectRevert(CompositionSourceAdapter.EmptySourceOutput.selector);
        CompositionSourceAdapter(sourceAdapters[0]).readLatest();

        _updateSource(1, 31, keccak256("overflow root"), uint256(type(uint128).max) + 1);
        vm.expectPartialRevert(CompositionSourceAdapter.InvalidTotalValue.selector);
        CompositionSourceAdapter(sourceAdapters[1]).readLatest();
    }

    function test_WrongVerifierAcceptedOutputFailsHistoricalAdapterCheck() public {
        _createSources(2, true);
        CompositionProgramVerifier wrong = new CompositionProgramVerifier(keccak256("wrong program"));
        sourceSnapshots[0].setZkVerifier(wrong);
        _updateSource(0, 30, keccak256("wrong-verifier-root"), 1_000);

        vm.expectPartialRevert(CompositionSourceAdapter.WrongVerifier.selector);
        CompositionSourceAdapter(sourceAdapters[0]).readLatest();
    }

    function test_AttachDistributorDeploysAFundOwnedByTheVerifiedAuthority() public {
        _createSources(2, true);
        (bytes32 instanceId, MerkleSnapshot snapshot,,) = _createComposition(2, MAX_AGE);
        assertEq(factory.distributorOf(instanceId), address(0), "created without a fund");

        MockSafeOwner safe = new MockSafeOwner(address(this), 1);
        snapshot.proposeConstitutionalTransfer(address(safe));
        vm.prank(address(safe));
        snapshot.acceptConstitutionalTransfer();

        vm.prank(address(0x57AA));
        address distributor = factory.attachDistributor(instanceId, address(safe), address(0));
        assertEq(MerkleFundDistributor(payable(distributor)).owner(), address(safe), "fund owner is the Safe authority");
        assertEq(MerkleFundDistributor(payable(distributor)).merkleSnapshot(), address(snapshot));
        assertEq(factory.distributorOf(instanceId), distributor);

        vm.expectRevert(
            abi.encodeWithSelector(DistributorAttaching.DistributorAlreadyAttached.selector, instanceId, distributor)
        );
        factory.attachDistributor(instanceId, address(safe), address(0));

        // The authority gate, on an instance that has no fund yet.
        (bytes32 gatedInstanceId,,,) = _createComposition(2, MAX_AGE);
        vm.expectRevert(
            abi.encodeWithSelector(DistributorAttaching.NotInstanceAuthority.selector, gatedInstanceId, address(0x57AA))
        );
        factory.attachDistributor(gatedInstanceId, address(0x57AA), address(0));

        // Wrong-program ids are refused: the source instances are trust graphs, not compositions.
        vm.expectRevert(abi.encodeWithSelector(DistributorAttaching.UnknownInstance.selector, bytes32(uint256(1))));
        factory.attachDistributor(bytes32(uint256(1)), address(this), address(0));
    }

    function _createSources(uint256 count, bool accepted) internal {
        for (uint256 i; i < count; ++i) {
            _createSourceWithProgramAccepted(i, _sourceProgram(i), accepted);
        }
    }

    function _createSourceWithProgram(uint256 index, bytes32 program) internal {
        _createSourceWithProgramAccepted(index, program, true);
    }

    function _createSourceWithProgramAccepted(uint256 index, bytes32 program, bool accepted) internal {
        MockAccumulator sourceAccumulator = new MockAccumulator();
        MerkleSnapshot sourceSnapshot = new MerkleSnapshot(
            sourceVerifier,
            keccak256(abi.encode("source params", index)),
            sourceAccumulator,
            address(this),
            address(this),
            ""
        );
        sourceSnapshot.enableStateProvenance();
        bytes32 sourceInstanceId = bytes32(index + 1);
        registry.registerWithParamsAuthority(
            sourceInstanceId,
            IInstanceRegistry.Instance({
                program: program,
                snapshot: address(sourceSnapshot),
                verifier: address(sourceVerifier),
                registryOrAccumulator: address(sourceAccumulator),
                paramsHash: sourceSnapshot.paramsHash()
            }),
            address(this)
        );
        if (accepted) {
            sourceAccumulator.setState(keccak256(abi.encode("acc", index)), uint64(index + 1));
            vm.roll(10);
            uint256 checkpoint = sourceSnapshot.trigger();
            sourceSnapshot.submitProof(
                checkpoint,
                keccak256(abi.encode("root", index)),
                sha256(abi.encode("blob", index)),
                string.concat("bafk-source-", vm.toString(index)),
                1_000 + index,
                bytes32(0),
                address(0),
                ""
            );
        }
        CompositionSourceAdapter adapter = adapterFactory.create(
            registry,
            sourceInstanceId,
            bytes32(index + 1),
            FAMILY,
            OUTPUT_KIND,
            keccak256(abi.encode("deployment provenance", index))
        );
        sourceSnapshots.push(sourceSnapshot);
        sourceAccumulators.push(sourceAccumulator);
        sourceAdapters.push(address(adapter));
    }

    function _updateSource(uint256 index, uint64 atBlock, bytes32 root, uint256 total) internal {
        sourceAccumulators[index].setState(keccak256(abi.encode("updated acc", index, atBlock, root, total)), atBlock);
        vm.roll(atBlock);
        uint256 checkpoint = sourceSnapshots[index].trigger();
        sourceSnapshots[index].submitProof(
            checkpoint,
            root,
            sha256(abi.encode("updated blob", index, atBlock)),
            string.concat("bafk-updated-", vm.toString(index), "-", vm.toString(atBlock)),
            total,
            bytes32(0),
            address(0),
            ""
        );
    }

    function _createComposition(uint256 count, uint64 maxAge)
        internal
        returns (
            bytes32 instanceId,
            MerkleSnapshot snapshot,
            CompositionSourceAccumulator accumulator,
            bytes memory manifest
        )
    {
        manifest = _policyManifest(count, maxAge, false);
        TrustComposeFactory.CreateArgs memory args;
        args.name = string.concat("composition-", vm.toString(registry.instanceCount()));
        args.metadataURI = "ipfs://composition-metadata";
        args.params = _params(maxAge);
        args.policyManifest = manifest;
        args.sourceAdapters = _adapterSlice(count);
        args.metadataDigest = keccak256("review packet");
        args.epochLength = 3;
        address snapshotAddress;
        address accumulatorAddress;
        (instanceId, snapshotAddress, accumulatorAddress,) = factory.createInstance(args);
        snapshot = MerkleSnapshot(snapshotAddress);
        accumulator = CompositionSourceAccumulator(accumulatorAddress);
    }

    function _params(uint64 maxAge) internal pure returns (TrustComposeParamsCodec.Params memory p) {
        p.version = 1;
        p.programId = keccak256("trust-compose");
        p.scopeHash = keccak256("governance-allocation");
        p.identityDomain = keccak256("eip155-address");
        p.outputKind = OUTPUT_KIND;
        p.outputDomain = keccak256("trustgraphs.output.trust-compose-account.v1");
        p.sourceCompatibilityClass = TrustComposeValidator.SOURCE_COMPATIBILITY_CLASS;
        p.weightScale = SCALE;
        p.outputPool = 1_000_000;
        p.maxSources = 8;
        p.maxEntriesPerSource = 4_096;
        p.maxAggregateEntries = 8_192;
        p.maxUnionAccounts = 8_192;
        p.maxAggregateBlobBytes = 1_048_576;
        p.maxSourceAgeBlocks = maxAge;
    }

    function _adapterSlice(uint256 count) internal view returns (address[] memory adapters) {
        adapters = new address[](count);
        for (uint256 i; i < count; ++i) {
            adapters[i] = sourceAdapters[i];
        }
    }

    function _policyManifest(uint256 count, uint64 maxAge, bool reverseWeights)
        internal
        view
        returns (bytes memory manifest)
    {
        manifest = abi.encodePacked(bytes4("TGCP"), uint16(1), uint64(block.chainid), uint8(count));
        uint256 base = SCALE / count;
        uint256 remainder = SCALE % count;
        for (uint256 i; i < count; ++i) {
            uint64 weight = uint64(base + (i < remainder ? 1 : 0));
            if (reverseWeights && count == 2) weight = i == 0 ? uint64(4e17) : uint64(6e17);
            CompositionSourceAdapter adapter = CompositionSourceAdapter(sourceAdapters[i]);
            manifest = bytes.concat(
                manifest,
                abi.encodePacked(
                    adapter.sourceId(),
                    adapter.snapshot(),
                    adapter.familyId(),
                    adapter.programId(),
                    TrustComposeValidator.admittedSourceOutputDomain(adapter.programId()),
                    weight,
                    maxAge,
                    uint8(1)
                )
            );
        }
    }

    function _policyManifestWithDomains(uint64 maxAge, bytes32 firstDomain, bytes32 secondDomain)
        internal
        view
        returns (bytes memory manifest)
    {
        manifest = abi.encodePacked(bytes4("TGCP"), uint16(1), uint64(block.chainid), uint8(2));
        bytes32[2] memory domains = [firstDomain, secondDomain];
        for (uint256 i; i < 2; ++i) {
            CompositionSourceAdapter adapter = CompositionSourceAdapter(sourceAdapters[i]);
            manifest = bytes.concat(
                manifest,
                abi.encodePacked(
                    adapter.sourceId(),
                    adapter.snapshot(),
                    adapter.familyId(),
                    adapter.programId(),
                    domains[i],
                    uint64(SCALE / 2),
                    maxAge,
                    uint8(1)
                )
            );
        }
    }

    function _readUint(bytes memory data, uint256 offset, uint256 width) internal pure returns (uint256 value) {
        for (uint256 i; i < width; ++i) {
            value = (value << 8) | uint8(data[offset + i]);
        }
    }
}
