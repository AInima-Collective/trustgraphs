// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {CompositionSourceAdapter, CompositionSourceAdapterFactory} from "src/composition/CompositionSourceAdapter.sol";
import {CompositionSourceAccumulatorV2} from "src/composition/CompositionSourceAccumulatorV2.sol";
import {TrustComposeFactoryV2} from "src/factory/TrustComposeFactoryV2.sol";
import {TrustComposeParamsControllerV2} from "src/factory/TrustComposeParamsControllerV2.sol";
import {
    CompositionSourceAccumulatorV2Deployer,
    TrustComposeParamsControllerV2Deployer
} from "src/factory/TrustComposeInstanceDeployersV2.sol";
import {MerkleSnapshotDeployer, MerkleFundDistributorDeployer} from "src/factory/InstanceDeployers.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {TrustComposeParamsCodecV2} from "src/params/TrustComposeParamsCodecV2.sol";
import {TrustComposeValidatorV2} from "src/params/TrustComposeValidatorV2.sol";
import {ITrustComposeParamsControllerV2} from "interfaces/factory/ITrustComposeParamsControllerV2.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {MockAccumulator} from "../../mocks/MockAccumulator.sol";

contract CompositionV2ProgramVerifier is IZkVerifier {
    bytes32 public immutable programVKey;

    constructor(bytes32 programVKey_) {
        programVKey = programVKey_;
    }

    function verify(bytes calldata, bytes32) external pure {}
}

contract UnauthenticatedAdapterV2Lookalike {
    function sourceId() external pure returns (bytes32) {
        return bytes32(uint256(1));
    }
}

/// @notice The V1 capture battery mirrored onto V2, plus the mixed-source behavior V2 exists for:
///         one standard `trust-graph` source and one `trust-graph-weighted` source in a single
///         composition, each keeping its real program and output domain in the frozen TGCM bytes.
contract TrustComposeCaptureV2Test is Test {
    uint64 internal constant SCALE = 1e18;
    uint48 internal constant DELAY = 2 days;
    uint64 internal constant MAX_AGE = 500;
    bytes32 internal constant COMPOSE_VKEY = keccak256("composition v2 vkey");
    bytes32 internal constant SOURCE_VKEY = keccak256("source vkey");
    bytes32 internal constant FAMILY = keccak256("weighted-allocation-v1");
    bytes32 internal constant OUTPUT_KIND = keccak256("allocation");
    address internal constant NEW_OWNER = address(0xA11CE);

    InstanceRegistry internal registry;
    CompositionSourceAdapterFactory internal adapterFactory;
    CompositionV2ProgramVerifier internal sourceVerifier;
    CompositionV2ProgramVerifier internal composeVerifier;
    TrustComposeFactoryV2 internal factory;

    MerkleSnapshot[] internal sourceSnapshots;
    MockAccumulator[] internal sourceAccumulators;
    address[] internal sourceAdapters;

    function setUp() public {
        registry = new InstanceRegistry(address(this));
        adapterFactory = new CompositionSourceAdapterFactory(registry);
        sourceVerifier = new CompositionV2ProgramVerifier(SOURCE_VKEY);
        composeVerifier = new CompositionV2ProgramVerifier(COMPOSE_VKEY);
        factory = new TrustComposeFactoryV2(
            composeVerifier,
            COMPOSE_VKEY,
            registry,
            adapterFactory,
            new MerkleSnapshotDeployer(),
            new MerkleFundDistributorDeployer(),
            new CompositionSourceAccumulatorV2Deployer(),
            new TrustComposeParamsControllerV2Deployer(),
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
            ? TrustComposeValidatorV2.TRUST_GRAPH_PROGRAM_ID
            : TrustComposeValidatorV2.WEIGHTED_TRUST_GRAPH_PROGRAM_ID;
    }

    function test_MixedCreationFreezesBothRealProgramsAndDerivedDomains() public {
        _createSources(2, true);
        (bytes32 instanceId, MerkleSnapshot snapshot, CompositionSourceAccumulatorV2 accumulator,) =
            _createComposition(2, MAX_AGE);

        vm.roll(100);
        uint256 checkpoint = snapshot.trigger();
        bytes memory frozen = accumulator.getCaptureManifest(checkpoint);
        assertEq(frozen.length, 23 + 2 * 293);
        assertEq(bytes4(uint32(_readUint(frozen, 0, 4))), bytes4("TGCM"));
        assertEq(_readUint(frozen, 4, 2), 2, "manifest version is 2");
        assertEq(_readUint(frozen, 6, 8), block.chainid);
        assertEq(_readUint(frozen, 14, 8), 100);
        assertEq(_readUint(frozen, 22, 1), 2);

        // Each record retains its real program and its program-derived output domain — the
        // standard source is never relabelled to the weighted identity or vice versa.
        assertEq(bytes32(_readUint(frozen, 23 + 84, 32)), TrustComposeValidatorV2.TRUST_GRAPH_PROGRAM_ID);
        assertEq(bytes32(_readUint(frozen, 23 + 116, 32)), TrustComposeValidatorV2.TRUST_GRAPH_OUTPUT_DOMAIN);
        assertEq(bytes32(_readUint(frozen, 23 + 293 + 84, 32)), TrustComposeValidatorV2.WEIGHTED_TRUST_GRAPH_PROGRAM_ID);
        assertEq(
            bytes32(_readUint(frozen, 23 + 293 + 116, 32)), TrustComposeValidatorV2.WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN
        );

        assertEq(accumulator.getCheckpoint(checkpoint).acc, sha256(frozen));
        assertEq(accumulator.getCheckpoint(checkpoint).leafCount, 2);
        assertEq(accumulator.checkpointPolicyVersion(checkpoint), 1);

        IInstanceRegistry.Instance memory record = registry.getInstance(instanceId);
        assertEq(record.program, keccak256("trust-compose"), "V2 keeps the shared composition program ID");
        assertEq(record.verifier, address(composeVerifier));
        assertEq(record.snapshot, address(snapshot));
        assertEq(record.registryOrAccumulator, address(accumulator));
    }

    function test_AtomicCaptureIsImmutableAndPreservesUnchangedSources() public {
        _createSources(2, true);
        (, MerkleSnapshot snapshot, CompositionSourceAccumulatorV2 accumulator,) = _createComposition(2, MAX_AGE);

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

    function test_V1PolicyManifestBytesAreRejectedNotReinterpreted() public {
        _createSources(2, true);
        bytes memory v1Manifest = abi.encodePacked(bytes4("TGCP"), uint16(1), uint64(block.chainid), uint8(2));
        for (uint256 i; i < 2; ++i) {
            CompositionSourceAdapter adapter = CompositionSourceAdapter(sourceAdapters[i]);
            v1Manifest = bytes.concat(
                v1Manifest,
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
        TrustComposeFactoryV2.CreateArgs memory args;
        args.name = "v1-bytes-under-v2";
        args.params = _params(MAX_AGE);
        args.policyManifest = v1Manifest;
        args.sourceAdapters = _adapterSlice(2);
        args.epochLength = 3;
        vm.expectRevert(abi.encodeWithSelector(TrustComposeValidatorV2.InvalidManifestVersion.selector, uint16(1)));
        factory.createInstance(args);
    }

    function test_CrossedOutputDomainsFailClosedAtCreation() public {
        _createSources(2, true);
        bytes memory crossed = _policyManifestWithDomains(
            MAX_AGE,
            TrustComposeValidatorV2.WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN,
            TrustComposeValidatorV2.TRUST_GRAPH_OUTPUT_DOMAIN
        );
        TrustComposeFactoryV2.CreateArgs memory args;
        args.name = "crossed-domains";
        args.params = _params(MAX_AGE);
        args.policyManifest = crossed;
        args.sourceAdapters = _adapterSlice(2);
        args.epochLength = 3;
        vm.expectPartialRevert(TrustComposeValidatorV2.WrongSourceOutputDomain.selector);
        factory.createInstance(args);
    }

    function test_UnadmittedThirdProgramSourceFailsClosedAtCreation() public {
        _createSources(2, true);
        _createSourceWithProgram(2, keccak256("contributions"));
        bytes memory manifest = abi.encodePacked(bytes4("TGCP"), uint16(2), uint64(block.chainid), uint8(3));
        uint64[3] memory weights = [uint64(35e16), uint64(55e16), uint64(10e16)];
        bytes32[3] memory domains = [
            TrustComposeValidatorV2.TRUST_GRAPH_OUTPUT_DOMAIN,
            TrustComposeValidatorV2.WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN,
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
        TrustComposeFactoryV2.CreateArgs memory args;
        args.name = "unadmitted-third-program";
        args.params = _params(MAX_AGE);
        args.policyManifest = manifest;
        args.sourceAdapters = _adapterSlice(3);
        args.epochLength = 3;
        vm.expectRevert(
            abi.encodeWithSelector(
                TrustComposeValidatorV2.UnadmittedSourceProgram.selector, uint8(2), keccak256("contributions")
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
        vm.expectPartialRevert(CompositionSourceAccumulatorV2.StaleSource.selector);
        staleSnapshot.trigger();
    }

    function test_ControllerRotationAndUnreviewedLookalikeFailClosed() public {
        _createSources(2, true);
        (bytes32 instanceId, MerkleSnapshot snapshot,, bytes memory manifest) = _createComposition(2, MAX_AGE);
        TrustComposeParamsControllerV2 controller = TrustComposeParamsControllerV2(registry.paramsAuthority(instanceId));

        address[] memory lookalikes = _adapterSlice(2);
        lookalikes[0] = address(new UnauthenticatedAdapterV2Lookalike());
        vm.expectPartialRevert(CompositionSourceAccumulatorV2.UnauthenticatedAdapter.selector);
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
            CompositionSourceAccumulatorV2 accumulator,
            bytes memory initial
        ) = _createComposition(2, MAX_AGE);
        TrustComposeParamsControllerV2 controller = TrustComposeParamsControllerV2(registry.paramsAuthority(instanceId));
        bytes32 initialHash = controller.currentParamsHash();
        bytes memory rotated = _policyManifest(2, MAX_AGE, true);
        address[] memory adapters = _adapterSlice(2);

        (uint64 cancelledVersion,,) = controller.proposePolicy(rotated, adapters, keccak256("cancelled"));
        vm.expectPartialRevert(TrustComposeParamsControllerV2.ActivationDelayNotElapsed.selector);
        controller.activatePolicy(cancelledVersion, rotated, adapters);
        controller.cancelPolicy();
        assertEq(
            uint8(controller.versionCommitment(cancelledVersion).status),
            uint8(ITrustComposeParamsControllerV2.ProposalStatus.Cancelled)
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
        (bytes32 instanceId,, CompositionSourceAccumulatorV2 accumulator, bytes memory manifest) =
            _createComposition(2, MAX_AGE);
        TrustComposeParamsControllerV2 controller = TrustComposeParamsControllerV2(registry.paramsAuthority(instanceId));
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
        emit log_named_uint("trust-compose-v2 trigger gas (2 sources)", twoGas);
        emit log_named_uint("trust-compose-v2 trigger gas (8 sources)", eightGas);
        assertLt(twoGas, 3_500_000);
        assertLt(eightGas, 9_000_000);
        assertGt(eightGas, twoGas);
    }

    function test_FactoryAndDeployersRetainNoAuthorityAndHaveEip170Headroom() public {
        _createSources(2, true);
        (bytes32 instanceId, MerkleSnapshot snapshot, CompositionSourceAccumulatorV2 accumulator,) =
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
        // The V2 controller embeds the closed compatibility-class constants, which costs a few
        // dozen bytes over the V1 margin convention. If this margin ever gets tight, the escape
        // hatch is compiling the validator as an external library, not deleting checks.
        assertGt(
            24_576 - address(factory.PARAMS_CONTROLLER_DEPLOYER()).code.length,
            2_500,
            "controller deployer runtime margin"
        );
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
            CompositionSourceAccumulatorV2 accumulator,
            bytes memory manifest
        )
    {
        manifest = _policyManifest(count, maxAge, false);
        TrustComposeFactoryV2.CreateArgs memory args;
        args.name = string.concat("composition-v2-", vm.toString(registry.instanceCount()));
        args.metadataURI = "ipfs://composition-v2-metadata";
        args.params = _params(maxAge);
        args.policyManifest = manifest;
        args.sourceAdapters = _adapterSlice(count);
        args.metadataDigest = keccak256("review packet");
        args.epochLength = 3;
        address snapshotAddress;
        address accumulatorAddress;
        (instanceId, snapshotAddress, accumulatorAddress,) = factory.createInstance(args);
        snapshot = MerkleSnapshot(snapshotAddress);
        accumulator = CompositionSourceAccumulatorV2(accumulatorAddress);
    }

    function _params(uint64 maxAge) internal pure returns (TrustComposeParamsCodecV2.Params memory p) {
        p.version = 2;
        p.programId = keccak256("trust-compose");
        p.scopeHash = keccak256("governance-allocation");
        p.identityDomain = keccak256("eip155-address");
        p.outputKind = OUTPUT_KIND;
        p.outputDomain = keccak256("trustgraphs.output.trust-compose-account.v1");
        p.sourceCompatibilityClass = TrustComposeValidatorV2.SOURCE_COMPATIBILITY_CLASS;
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
        manifest = abi.encodePacked(bytes4("TGCP"), uint16(2), uint64(block.chainid), uint8(count));
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
                    TrustComposeValidatorV2.admittedSourceOutputDomain(adapter.programId()),
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
        manifest = abi.encodePacked(bytes4("TGCP"), uint16(2), uint64(block.chainid), uint8(2));
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
