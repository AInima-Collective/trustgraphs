// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {GraphLineageRegistry} from "contracts/registry/GraphLineageRegistry.sol";
import {InstanceRegistry} from "contracts/registry/InstanceRegistry.sol";
import {IGraphLineageRegistry} from "interfaces/registry/IGraphLineageRegistry.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleSnapshotProvenance} from "interfaces/merkle/IMerkleSnapshotProvenance.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

contract LineageControllerFixture {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function setOwner(address owner_) external {
        require(msg.sender == owner, "owner");
        owner = owner_;
    }
}

contract LineageSnapshotFixture {
    IMerkleSnapshot.MerkleState private _state;
    IMerkleSnapshotProvenance.StateProvenance private _provenance;

    constructor(bytes32 root_, bytes32 paramsHash, address verifier) {
        _state = IMerkleSnapshot.MerkleState({
            blockNumber: 700,
            timestamp: 800,
            root: root_,
            ipfsHash: sha256("canonical graph bytes"),
            ipfsHashCid: "bafkreicanonical",
            totalValue: 1_000_000
        });
        _provenance = IMerkleSnapshotProvenance.StateProvenance({
            stateIndex: 2,
            checkpointId: 9,
            acceptedAtBlock: 730,
            paramsHash: paramsHash,
            verifier: verifier,
            verifierCodehash: keccak256("verifier-code"),
            programVKey: keccak256("program-vkey")
        });
    }

    function getAcceptedCheckpoint(uint256 checkpointId)
        external
        view
        returns (IMerkleSnapshot.MerkleState memory state, IMerkleSnapshotProvenance.StateProvenance memory provenance)
    {
        require(checkpointId == _provenance.checkpointId, "checkpoint");
        return (_state, _provenance);
    }

    function root() external view returns (bytes32) {
        return _state.root;
    }
}

contract GraphLineageRegistryTest is Test {
    bytes32 internal constant PROGRAM = keccak256("trust-graph");
    bytes32 internal constant PARAMS = keccak256("params-v1");
    bytes32 internal constant PARAMS_V2 = keccak256("params-v2");
    bytes32 internal constant FAMILY_A = keccak256("family-a");
    bytes32 internal constant FAMILY_B = keccak256("family-b");
    bytes32 internal constant FAMILY_C = keccak256("family-c");
    bytes32 internal constant METHOD = keccak256("pagerank-v1");
    bytes32 internal constant SCOPE_A = keccak256("governance-a");
    bytes32 internal constant SCOPE_B = keccak256("governance-b");
    bytes32 internal constant IDENTITY_DOMAIN = keccak256("eip155-address");
    bytes32 internal constant POLICY = keccak256("atomic-only");
    bytes32 internal constant INSTANCE_A = keccak256("instance-a");
    bytes32 internal constant INSTANCE_B = keccak256("instance-b");
    bytes32 internal constant INSTANCE_C = keccak256("instance-c");
    bytes32 internal constant ROOT = keccak256("same-root");
    address internal constant VERIFIER = address(0xBEEF);
    address internal constant ACCUMULATOR = address(0xACCA);

    address internal alice = makeAddr("alice-authority");
    address internal bob = makeAddr("bob-authority");
    address internal carol = makeAddr("carol-authority");
    address internal dave = makeAddr("rotated-authority");
    address internal stranger = makeAddr("stranger");

    InstanceRegistry internal instances;
    InstanceRegistry internal otherInstances;
    GraphLineageRegistry internal registry;
    GraphLineageRegistry internal otherRegistry;
    LineageControllerFixture internal controllerA;
    LineageControllerFixture internal controllerB;
    LineageControllerFixture internal controllerC;
    LineageSnapshotFixture internal snapshot;
    bytes32 internal lineageA;
    bytes32 internal lineageB;
    bytes32 internal lineageC;
    bytes32 internal configA;
    bytes32 internal configB;
    bytes32 internal configC;

    function setUp() public {
        vm.warp(1 days);
        instances = new InstanceRegistry(address(this));
        otherInstances = new InstanceRegistry(address(this));
        registry = new GraphLineageRegistry(instances);
        otherRegistry = new GraphLineageRegistry(otherInstances);
        controllerA = new LineageControllerFixture(alice);
        controllerB = new LineageControllerFixture(bob);
        controllerC = new LineageControllerFixture(carol);
        snapshot = new LineageSnapshotFixture(ROOT, PARAMS, VERIFIER);

        _registerInstance(instances, INSTANCE_A, controllerA, PARAMS);
        _registerInstance(instances, INSTANCE_B, controllerB, PARAMS);
        _registerInstance(instances, INSTANCE_C, controllerC, PARAMS);
        _registerInstance(otherInstances, INSTANCE_A, controllerA, PARAMS);

        (lineageA, configA) = _registerLineage(registry, INSTANCE_A, FAMILY_A, alice, "Same graph");
        (lineageB, configB) = _registerLineage(registry, INSTANCE_B, FAMILY_B, bob, "Same graph");
        (lineageC, configC) = _registerLineage(registry, INSTANCE_C, FAMILY_C, carol, "Graph C");
    }

    function testLineageIdentityQualifiesRegistryAndInstanceNotNameOrRoot() public {
        vm.prank(alice);
        (bytes32 otherLineage,) = otherRegistry.registerLineage(
            INSTANCE_A, FAMILY_A, METHOD, SCOPE_A, IDENTITY_DOMAIN, POLICY, "Same graph", "ipfs://same-metadata"
        );

        assertNotEq(lineageA, lineageB, "instance id must qualify lineage");
        assertNotEq(lineageA, otherLineage, "instance registry must qualify lineage");
        assertEq(snapshot.root(), ROOT, "fixture roots really are identical");
        assertEq(registry.lineageIdFor(INSTANCE_A), lineageA);
    }

    function testAuthorityAuthenticationReplayVersionScopeAndEvidenceMutability() public {
        IGraphLineageRegistry.EndorsementInput memory input =
            _input(lineageA, lineageB, configB, SCOPE_A, IGraphLineageRegistry.EndorsementKind.Integrity, 7e17, 1);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IGraphLineageRegistry.Unauthorized.selector, stranger, alice));
        registry.issueEndorsement(input);

        vm.prank(alice);
        bytes32 endorsementId = registry.issueEndorsement(input);
        IGraphLineageRegistry.Endorsement memory endorsement = registry.getEndorsement(endorsementId);
        assertEq(endorsement.evidenceDigest, bytes32(0), "zero digest explicitly marks mutable evidence");
        assertEq(uint256(registry.endorsementStatus(endorsementId, SCOPE_A, configB)), 1);
        assertEq(uint256(registry.endorsementStatus(endorsementId, SCOPE_B, configB)), 2);
        assertEq(uint256(registry.endorsementStatus(endorsementId, SCOPE_A, keccak256("wrong-version"))), 3);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGraphLineageRegistry.InvalidSequence.selector, 2, 1));
        registry.issueEndorsement(input);

        input.scopeHash = SCOPE_B;
        input.sequence = 1;
        input.subjectConfigurationId = keccak256("wrong-version");
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IGraphLineageRegistry.SubjectConfigurationMismatch.selector, configB, input.subjectConfigurationId
            )
        );
        registry.issueEndorsement(input);
    }

    function testOnlyReferralPropagatesAndBudgetLeavesUnusedMassExplicit() public {
        IGraphLineageRegistry.EndorsementKind[4] memory nonPropagating = [
            IGraphLineageRegistry.EndorsementKind.Integrity,
            IGraphLineageRegistry.EndorsementKind.Methodology,
            IGraphLineageRegistry.EndorsementKind.Agreement,
            IGraphLineageRegistry.EndorsementKind.Warning
        ];
        for (uint256 i = 0; i < nonPropagating.length; ++i) {
            vm.prank(alice);
            registry.issueEndorsement(
                _input(lineageA, lineageB, configB, SCOPE_A, nonPropagating[i], 1e18, uint64(i + 1))
            );
        }
        (uint256 spent, uint256 unused) = registry.activeReferralSpend(lineageA, SCOPE_A);
        assertEq(spent, 0, "evidence and warnings never spend referral mass");
        assertEq(unused, 1e18);

        vm.prank(alice);
        bytes32 referralB = registry.issueEndorsement(
            _input(lineageA, lineageB, configB, SCOPE_A, IGraphLineageRegistry.EndorsementKind.Referral, 6e17, 5)
        );
        vm.prank(alice);
        bytes32 referralC = registry.issueEndorsement(
            _input(lineageA, lineageC, configC, SCOPE_A, IGraphLineageRegistry.EndorsementKind.Referral, 4e17, 6)
        );
        (spent, unused) = registry.activeReferralSpend(lineageA, SCOPE_A);
        assertEq(spent, 1e18);
        assertEq(unused, 0);

        IGraphLineageRegistry.EndorsementInput memory over =
            _input(lineageA, lineageB, configB, SCOPE_A, IGraphLineageRegistry.EndorsementKind.Referral, 7e17, 7);
        over.supersedes = referralB;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGraphLineageRegistry.ReferralBudgetExceeded.selector, 1.1e18, 1e18));
        registry.issueEndorsement(over);

        vm.warp(block.timestamp + 31 days);
        assertEq(uint256(registry.endorsementStatus(referralB, SCOPE_A, configB)), 7);
        assertEq(uint256(registry.endorsementStatus(referralC, SCOPE_A, configC)), 7);
        (spent, unused) = registry.activeReferralSpend(lineageA, SCOPE_A);
        assertEq(spent, 0);
        assertEq(unused, 1e18, "expired mass remains explicit rather than redistributed");
    }

    function testFutureReferralWindowsCannotActivateAboveBudget() public {
        IGraphLineageRegistry.EndorsementInput memory futureB =
            _input(lineageA, lineageB, configB, SCOPE_A, IGraphLineageRegistry.EndorsementKind.Referral, 6e17, 1);
        futureB.validFrom = uint48(block.timestamp + 10 days);
        futureB.validUntil = uint48(block.timestamp + 20 days);
        vm.prank(alice);
        bytes32 referralB = registry.issueEndorsement(futureB);

        (uint256 spent, uint256 unused) = registry.activeReferralSpend(lineageA, SCOPE_A);
        assertEq(spent, 0, "future mass is not active early");
        assertEq(unused, 1e18);

        IGraphLineageRegistry.EndorsementInput memory overlappingC =
            _input(lineageA, lineageC, configC, SCOPE_A, IGraphLineageRegistry.EndorsementKind.Referral, 5e17, 2);
        overlappingC.validFrom = futureB.validFrom;
        overlappingC.validUntil = futureB.validUntil;

        // A transient subject rotation cannot be used to overbook a window and then resurrect the
        // old referral by restoring the tuple without recording a new configuration version.
        vm.prank(address(controllerB));
        instances.updateParamsHash(INSTANCE_B, PARAMS_V2);
        assertFalse(registry.configurationLive(configB));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGraphLineageRegistry.ReferralBudgetExceeded.selector, 1.1e18, 1e18));
        registry.issueEndorsement(overlappingC);
        vm.prank(address(controllerB));
        instances.updateParamsHash(INSTANCE_B, PARAMS);
        assertTrue(registry.configurationLive(configB));

        overlappingC.validFrom = futureB.validUntil;
        overlappingC.validUntil = uint48(futureB.validUntil + 10 days);
        vm.prank(alice);
        bytes32 referralC = registry.issueEndorsement(overlappingC);

        vm.warp(futureB.validFrom);
        assertEq(uint256(registry.endorsementStatus(referralB, SCOPE_A, configB)), 1);
        assertEq(uint256(registry.endorsementStatus(referralC, SCOPE_A, configC)), 6);
        vm.warp(futureB.validUntil);
        assertEq(uint256(registry.endorsementStatus(referralB, SCOPE_A, configB)), 7);
        assertEq(uint256(registry.endorsementStatus(referralC, SCOPE_A, configC)), 1);
    }

    function testSupersessionRevocationCyclesAndMultipleScopes() public {
        vm.prank(alice);
        bytes32 first = registry.issueEndorsement(
            _input(lineageA, lineageB, configB, SCOPE_A, IGraphLineageRegistry.EndorsementKind.Referral, 3e17, 1)
        );
        IGraphLineageRegistry.EndorsementInput memory replacement =
            _input(lineageA, lineageB, configB, SCOPE_A, IGraphLineageRegistry.EndorsementKind.Referral, 2e17, 2);
        replacement.supersedes = first;
        vm.prank(alice);
        bytes32 second = registry.issueEndorsement(replacement);
        assertEq(uint256(registry.endorsementStatus(first, SCOPE_A, configB)), 5);

        vm.prank(bob);
        registry.issueEndorsement(
            _input(lineageB, lineageC, configC, SCOPE_A, IGraphLineageRegistry.EndorsementKind.Referral, 5e17, 1)
        );
        vm.prank(carol);
        registry.issueEndorsement(
            _input(lineageC, lineageA, configA, SCOPE_A, IGraphLineageRegistry.EndorsementKind.Referral, 5e17, 1)
        );

        vm.prank(alice);
        bytes32 otherScope = registry.issueEndorsement(
            _input(lineageA, lineageC, configC, SCOPE_B, IGraphLineageRegistry.EndorsementKind.Referral, 1e18, 1)
        );
        assertEq(uint256(registry.endorsementStatus(otherScope, SCOPE_A, configC)), 2);

        bytes32 revocation = keccak256("evidence-retracted");
        vm.prank(alice);
        registry.revokeEndorsement(second, revocation);
        assertEq(uint256(registry.endorsementStatus(second, SCOPE_A, configB)), 4);
        assertEq(registry.getEndorsement(second).revocationRef, revocation);
    }

    function testRotationsFailClosedAndNewAuthorityMustRecordHistory() public {
        vm.prank(alice);
        bytes32 endorsement = registry.issueEndorsement(
            _input(lineageA, lineageB, configB, SCOPE_A, IGraphLineageRegistry.EndorsementKind.Referral, 5e17, 1)
        );

        vm.prank(address(controllerA));
        instances.updateParamsHash(INSTANCE_A, PARAMS_V2);
        assertFalse(registry.configurationLive(configA));
        assertEq(uint256(registry.endorsementStatus(endorsement, SCOPE_A, configB)), 8);

        vm.prank(alice);
        bytes32 configA2 = registry.syncConfiguration(lineageA, FAMILY_A, METHOD, SCOPE_A, IDENTITY_DOMAIN, POLICY);
        assertTrue(registry.configurationLive(configA2));

        vm.prank(bob);
        controllerB.setOwner(dave);
        assertFalse(registry.configurationLive(configB));

        IGraphLineageRegistry.EndorsementInput memory next =
            _input(lineageA, lineageB, configB, SCOPE_A, IGraphLineageRegistry.EndorsementKind.Referral, 5e17, 2);
        next.supersedes = endorsement;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGraphLineageRegistry.ConfigurationNotLive.selector, lineageB, configB));
        registry.issueEndorsement(next);

        vm.prank(dave);
        bytes32 configB2 = registry.syncConfiguration(lineageB, FAMILY_B, METHOD, SCOPE_A, IDENTITY_DOMAIN, POLICY);
        next.subjectConfigurationId = configB2;
        vm.prank(alice);
        bytes32 afterRotation = registry.issueEndorsement(next);
        assertEq(uint256(registry.endorsementStatus(afterRotation, SCOPE_A, configB2)), 1);

        IInstanceRegistry.Instance memory changed = instances.getInstance(INSTANCE_B);
        changed.program = keccak256("different-program");
        instances.update(INSTANCE_B, changed);
        assertFalse(registry.configurationLive(configB2), "program rotation is fail-closed");
        assertEq(uint256(registry.endorsementStatus(afterRotation, SCOPE_A, configB2)), 9);
    }

    function testEpochPinsAuthenticatedConfigurationAndEndorsementsCannotChangeRoot() public {
        bytes32 beforeRoot = snapshot.root();
        vm.prank(alice);
        bytes32 epochId = registry.publishEpoch(lineageA, 9);
        IGraphLineageRegistry.Epoch memory epoch = registry.getEpoch(epochId);
        assertEq(epoch.lineageId, lineageA);
        assertEq(epoch.configurationId, configA);
        assertEq(epoch.freezeBlock, 700);
        assertEq(epoch.acceptedAtBlock, 730);
        assertEq(epoch.root, ROOT);
        assertEq(epoch.cidDigest, keccak256(bytes("bafkreicanonical")));

        vm.prank(alice);
        registry.issueEndorsement(
            _input(lineageA, lineageB, configB, SCOPE_A, IGraphLineageRegistry.EndorsementKind.Warning, 1e18, 1)
        );
        assertEq(snapshot.root(), beforeRoot, "advisory metadata has no score/root write path");
    }

    function _registerInstance(
        InstanceRegistry target,
        bytes32 instanceId,
        LineageControllerFixture controller,
        bytes32 paramsHash
    ) internal {
        target.registerWithParamsAuthority(
            instanceId,
            IInstanceRegistry.Instance({
                program: PROGRAM,
                snapshot: address(snapshot),
                verifier: VERIFIER,
                registryOrAccumulator: ACCUMULATOR,
                paramsHash: paramsHash
            }),
            address(controller)
        );
    }

    function _registerLineage(
        GraphLineageRegistry target,
        bytes32 instanceId,
        bytes32 familyId,
        address authority,
        string memory name
    ) internal returns (bytes32 lineageId, bytes32 configurationId) {
        vm.prank(authority);
        return target.registerLineage(
            instanceId, familyId, METHOD, SCOPE_A, IDENTITY_DOMAIN, POLICY, name, "ipfs://same-metadata"
        );
    }

    function _input(
        bytes32 issuer,
        bytes32 subject,
        bytes32 subjectConfiguration,
        bytes32 scope,
        IGraphLineageRegistry.EndorsementKind kind,
        uint256 weight,
        uint64 sequence
    ) internal view returns (IGraphLineageRegistry.EndorsementInput memory) {
        return IGraphLineageRegistry.EndorsementInput({
            issuerLineageId: issuer,
            subjectLineageId: subject,
            subjectConfigurationId: subjectConfiguration,
            scopeHash: scope,
            kind: kind,
            weight: weight,
            validFrom: uint48(block.timestamp),
            validUntil: uint48(block.timestamp + 30 days),
            evidenceURI: "https://evidence.example/claim.json",
            evidenceDigest: bytes32(0),
            sequence: sequence,
            supersedes: bytes32(0)
        });
    }
}
