// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {GraphLineageRegistry} from "src/registry/GraphLineageRegistry.sol";
import {IGraphLineageRegistry} from "interfaces/registry/IGraphLineageRegistry.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {MockZkVerifier} from "test/mocks/MockZkVerifier.sol";
import {MockAccumulator} from "test/mocks/MockAccumulator.sol";

/// @notice Minimal stand-in for a typed params controller: the lineage registry only reads
///         `owner()` off whatever address the instance registry names as `paramsAuthority`.
contract QuillOwnedController {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }
}

/// @notice state-invariant-detection PoC.
///
/// Invariant under test (Type 5, synchronization/coupling):
///   `GraphLineageRegistry` claims "Every active endorsement remains pinned to live
///   InstanceRegistry and controller-owner facts, so a rotation fails closed even before
///   somebody records a new configuration version."
///
/// `_configurationLive` compares `config.paramsHash` against the InstanceRegistry's MIRRORED
/// copy (`record.paramsHash`), never against the snapshot's live `paramsHash()`. Those two
/// are only kept equal by the typed controller. `MerkleSnapshot.setParamsHash` is reachable
/// by any OPERATIONAL_ROLE holder - and CONSTITUTIONAL_ROLE (the instance's own admin/Safe)
/// administers OPERATIONAL_ROLE, so it can always grant itself that role. A params rotation
/// taken that way changes what the graph computes while every endorsement pinned to the old
/// configuration keeps reading `Active`.
contract QuillStateInv_LineageParamsHashDesync is Test {
    InstanceRegistry internal registry;
    GraphLineageRegistry internal lineage;
    MerkleSnapshot internal snapshot;
    MockAccumulator internal accumulator;
    MockZkVerifier internal verifier;
    QuillOwnedController internal controller;

    address internal registryAdmin = address(0xBEEF);
    address internal instanceAdmin = address(0xCAFE);

    bytes32 internal constant INSTANCE_ID = keccak256("quill.instance");
    bytes32 internal constant PARAMS_V1 = keccak256("params.v1");
    bytes32 internal constant PARAMS_V2 = keccak256("params.v2");

    function setUp() public {
        registry = new InstanceRegistry(registryAdmin);
        lineage = new GraphLineageRegistry(IInstanceRegistry(address(registry)));
        verifier = new MockZkVerifier();
        accumulator = new MockAccumulator();
        controller = new QuillOwnedController(instanceAdmin);

        // The instance admin holds BOTH roles, exactly as a creator-admin'd instance does before
        // graduation (see TrustgraphsFactory step 6: the factory grants CONSTITUTIONAL to `admin`).
        snapshot = new MerkleSnapshot(
            IZkVerifier(address(verifier)),
            PARAMS_V1,
            IAttestationAccumulator(address(accumulator)),
            instanceAdmin,
            instanceAdmin
        );

        vm.prank(registryAdmin);
        registry.registerWithParamsAuthority(
            INSTANCE_ID,
            IInstanceRegistry.Instance({
                program: keccak256("trust-graph"),
                snapshot: address(snapshot),
                verifier: address(verifier),
                registryOrAccumulator: address(accumulator),
                paramsHash: PARAMS_V1
            }),
            address(controller)
        );
    }

    function test_DirectParamsRotationLeavesLineageConfigurationReadingLive() public {
        vm.prank(instanceAdmin);
        (bytes32 lineageId, bytes32 configurationId) = lineage.registerLineage(
            INSTANCE_ID,
            keccak256("family"),
            keccak256("method"),
            keccak256("scope"),
            keccak256("eip155-address"),
            bytes32(0),
            "Quill Graph",
            "ipfs://quill"
        );
        assertTrue(lineage.configurationLive(configurationId), "config should start live");
        assertEq(lineage.getConfiguration(configurationId).paramsHash, PARAMS_V1);

        // The instance's own admin rotates the truth-defining parameter commitment DIRECTLY on the
        // snapshot. This is the value every proof is checked against (`trigger()` pins it per
        // checkpoint), so the graph now computes something else.
        vm.prank(instanceAdmin);
        snapshot.setParamsHash(PARAMS_V2);
        assertEq(snapshot.paramsHash(), PARAMS_V2, "snapshot rotated");

        // The registry's mirrored copy did not move, because `updateParamsHash` is callable only by
        // the paramsAuthority. Nothing re-syncs it.
        assertEq(registry.getInstance(INSTANCE_ID).paramsHash, PARAMS_V1, "registry copy is stale");

        // ...and therefore the lineage configuration still reads LIVE against a configuration whose
        // paramsHash no longer describes the instance. "Fails closed on rotation" does not hold for
        // this rotation path.
        assertTrue(
            lineage.configurationLive(configurationId),
            "BROKEN INVARIANT: configuration should not be live after a params rotation"
        );
        assertTrue(
            lineage.getConfiguration(configurationId).paramsHash != snapshot.paramsHash(),
            "pinned paramsHash and live paramsHash have diverged"
        );
        assertEq(lineage.getLineage(lineageId).currentConfigurationId, configurationId);
    }

    function test_EndorsementStaysActiveAcrossTheSameRotation() public {
        vm.startPrank(instanceAdmin);
        (bytes32 issuerLineage,) = lineage.registerLineage(
            INSTANCE_ID,
            keccak256("family"),
            keccak256("method"),
            keccak256("scope"),
            keccak256("eip155-address"),
            bytes32(0),
            "Issuer",
            "ipfs://issuer"
        );
        vm.stopPrank();

        // A second instance to endorse, sharing the same authority for brevity.
        bytes32 subjectInstance = keccak256("quill.subject");
        vm.prank(registryAdmin);
        registry.registerWithParamsAuthority(
            subjectInstance,
            IInstanceRegistry.Instance({
                program: keccak256("trust-graph"),
                snapshot: address(snapshot),
                verifier: address(verifier),
                registryOrAccumulator: address(accumulator),
                paramsHash: PARAMS_V1
            }),
            address(controller)
        );
        vm.prank(instanceAdmin);
        (bytes32 subjectLineage, bytes32 subjectConfig) = lineage.registerLineage(
            subjectInstance,
            keccak256("family"),
            keccak256("method"),
            keccak256("scope"),
            keccak256("eip155-address"),
            bytes32(0),
            "Subject",
            "ipfs://subject"
        );

        IGraphLineageRegistry.EndorsementInput memory input = IGraphLineageRegistry.EndorsementInput({
            issuerLineageId: issuerLineage,
            subjectLineageId: subjectLineage,
            subjectConfigurationId: subjectConfig,
            scopeHash: keccak256("scope"),
            kind: IGraphLineageRegistry.EndorsementKind.Referral,
            weight: 1e18,
            validFrom: uint48(block.timestamp),
            validUntil: uint48(block.timestamp + 30 days),
            evidenceURI: "ipfs://evidence",
            evidenceDigest: keccak256("evidence"),
            sequence: 1,
            supersedes: bytes32(0)
        });
        vm.prank(instanceAdmin);
        bytes32 endorsementId = lineage.issueEndorsement(input);
        assertEq(
            uint256(lineage.endorsementStatus(endorsementId, keccak256("scope"), subjectConfig)),
            uint256(IGraphLineageRegistry.EndorsementStatus.Active)
        );

        // Rotate the SUBJECT's live parameters directly on its snapshot.
        vm.prank(instanceAdmin);
        snapshot.setParamsHash(PARAMS_V2);

        assertEq(
            uint256(lineage.endorsementStatus(endorsementId, keccak256("scope"), subjectConfig)),
            uint256(IGraphLineageRegistry.EndorsementStatus.Active),
            "BROKEN INVARIANT: endorsement survives an unmirrored params rotation of its subject"
        );
    }
}
