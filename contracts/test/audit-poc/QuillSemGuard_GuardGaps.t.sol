// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {AnchorRegistry} from "src/registry/AnchorRegistry.sol";
import {EasOffchainAnchorRegistry} from "src/registry/EasOffchainAnchorRegistry.sol";
import {TrustAccumulatorMirror} from "src/merkle/TrustAccumulatorMirror.sol";
import {EmptyLaneAccumulator} from "src/merkle/EmptyLaneAccumulator.sol";
import {WeightedPriorParamsCodec} from "src/params/WeightedPriorParamsCodec.sol";
import {WeightedPriorValidator} from "src/params/WeightedPriorValidator.sol";
import {TrustgraphsParamsValidator} from "src/params/TrustgraphsParamsValidator.sol";
import {ParamsCodec} from "src/params/ParamsCodec.sol";
import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IAnchorRegistrySnapshotView} from "interfaces/registry/IAnchorRegistrySnapshotView.sol";

import {MockAccumulator} from "../mocks/MockAccumulator.sol";

/// @dev Minimal stand-in for the snapshot surface the two anchor registries read back.
contract SnapView is IAnchorRegistrySnapshotView {
    address public anchorRegistry;
    address public accumulator;

    constructor(address _anchorRegistry, address _accumulator) {
        anchorRegistry = _anchorRegistry;
        accumulator = _accumulator;
    }
}

/// @dev A snapshot-shaped contract that reads a DIFFERENT accumulator. Four of the five one-shot
///      binders in this repo refuse it; `TrustAccumulatorMirror` does not.
contract ForeignSnapshot {
    address public accumulator;

    constructor(address _accumulator) {
        accumulator = _accumulator;
    }
}

/// @title QuillSemGuard_GuardGaps
/// @notice Semantic-guard-analysis proofs: functions that skip a guard their own siblings apply.
contract QuillSemGuard_GuardGaps is Test {
    /*//////////////////////////////////////////////////////////////
      A. TrustAccumulatorMirror.bindSnapshot lacks the reciprocal
         `accumulator() == address(this)` read-back that
         AttestationAccumulator / EmptyLaneAccumulator / AnchorRegistry /
         EasOffchainAnchorRegistry all apply. One-shot + no unbind =
         permanently unusable mirror.
    //////////////////////////////////////////////////////////////*/

    function test_A_mirrorBindsToSnapshotThatReadsAnotherAccumulator() public {
        MockAccumulator trustAcc = new MockAccumulator();
        TrustAccumulatorMirror mirror = new TrustAccumulatorMirror(IAttestationAccumulator(address(trustAcc)));

        // A snapshot whose accumulator() is NOT this mirror.
        ForeignSnapshot wrong = new ForeignSnapshot(address(0xDEAD));

        // The sibling accumulator refuses exactly this.
        EmptyLaneAccumulator sibling = new EmptyLaneAccumulator();
        vm.expectRevert(
            abi.encodeWithSelector(EmptyLaneAccumulator.SnapshotReadsAnotherAccumulator.selector, address(0xDEAD))
        );
        sibling.bindSnapshot(address(wrong));

        // The mirror accepts it.
        mirror.bindSnapshot(address(wrong));
        assertEq(mirror.snapshot(), address(wrong), "mirror bound to a snapshot that reads another accumulator");

        // And the binding is one-shot with no unbind: the real snapshot can never mint here.
        vm.expectRevert(TrustAccumulatorMirror.AlreadyBound.selector);
        mirror.bindSnapshot(address(this));

        vm.prank(address(0xBEEF)); // stand-in for the real contributions MerkleSnapshot
        vm.expectRevert(TrustAccumulatorMirror.NotSnapshot.selector);
        mirror.checkpoint();
    }

    /*//////////////////////////////////////////////////////////////
      B. AnchorRegistry.anchor accepts four inputs its near-sibling
         EasOffchainAnchorRegistry.anchor rejects: zero head, zero
         dataCommitment, an arbitrary envelopeKind, and an unbounded
         per-node count jump. All fold irreversibly into anchorAcc.
    //////////////////////////////////////////////////////////////*/

    function test_B_anchorRegistryRejectsUnboundedCountButStillFoldsOtherMalformedFields() public {
        address admin = address(this);
        AnchorRegistry reg = new AnchorRegistry(admin, 200_000);

        MockAccumulator lane1 = new MockAccumulator();
        SnapView snap = new SnapView(address(reg), address(lane1));
        reg.bindSnapshot(address(snap));

        // A registrar-registered, non-address node kind: no head signature is checked at all.
        bytes32 nodeId = keccak256("did:plc:example");
        reg.registerNode(nodeId, reg.NODE_KIND_NOSTR());

        vm.expectRevert(
            abi.encodeWithSelector(AnchorRegistry.InvalidHeadCount.selector, type(uint64).max, reg.maxTotalInputs())
        );
        reg.anchor(nodeId, 199, bytes32(0), type(uint64).max, bytes32(0), "");
        assertEq(reg.anchorCount(), 0, "the out-of-range count was folded");

        // The remaining seam is independent of M-1a: foreign kind and zero commitments still fold.
        reg.anchor(nodeId, 199, bytes32(0), 1, bytes32(0), "");
        assertEq(reg.anchorCount(), 1, "the malformed anchor was folded");
        assertTrue(reg.anchorAcc() != bytes32(0), "anchorAcc irreversibly advanced");
        assertEq(reg.lastCount(nodeId), 1);
    }

    /// The sibling registry rejects every one of those inputs.
    function test_B_siblingEasRegistryRejectsTheSameInputs() public {
        address[] memory relayers = new address[](1);
        relayers[0] = address(this);
        address stub = address(new EasStub());
        EasOffchainAnchorRegistry eas = new EasOffchainAnchorRegistry(
            IEAS(stub), keccak256("schema"), 200_000, address(this), address(this), relayers
        );

        MockAccumulator lane1 = new MockAccumulator();
        SnapView snap = new SnapView(address(eas), address(lane1));
        eas.bindSnapshot(address(snap));

        bytes32 nodeId = keccak256("n");
        // foreign envelope kind
        vm.expectRevert(abi.encodeWithSelector(EasOffchainAnchorRegistry.InvalidEnvelopeKind.selector, uint8(199)));
        eas.anchor(nodeId, 199, bytes32(0), keccak256("h"), 1, keccak256("d"), "");
        // zero head / zero dataCommitment
        vm.expectRevert(EasOffchainAnchorRegistry.ZeroBytes32.selector);
        eas.anchor(nodeId, 0, bytes32(0), bytes32(0), 1, keccak256("d"), "");
        // unbounded count
        vm.expectRevert(
            abi.encodeWithSelector(EasOffchainAnchorRegistry.InvalidEntryCount.selector, type(uint64).max, uint64(2048))
        );
        eas.anchor(nodeId, 0, bytes32(0), keccak256("h"), type(uint64).max, keccak256("d"), "");
    }

    /*//////////////////////////////////////////////////////////////
      C. WeightedPriorValidator accepts a convergence tolerance that
         BOTH analogous validators reject: zero, and anything up to the
         full fixed-point scale (the siblings cap at 1e15).
    //////////////////////////////////////////////////////////////*/

    function test_C_weightedValidatorAcceptsToleranceZeroAndFullScale() public pure {
        WeightedPriorParamsCodec.Params memory w;
        w.version = 1;
        w.dampingFp = 0.85e18 > type(uint64).max ? 0 : uint64(0.85e18);
        w.toleranceFp = 0; // <-- rejected by the two sibling validators
        w.maxIterations = 40;
        w.minWeight = 0;
        w.maxWeight = 100;
        w.weightFieldIndex = 1;
        // Derived fields are zero at creation, as the factory requires.
        WeightedPriorValidator.validateCreation(w); // does NOT revert

        // ...and the whole fixed-point scale is inside the envelope too.
        w.toleranceFp = uint64(1e18);
        WeightedPriorValidator.validateCreation(w); // does NOT revert
    }

    /// The trust-graph validator, over the analogous field, rejects both.
    function test_C_trustValidatorRejectsBoth() public {
        ParamsCodec.Params memory p = _trustParams();

        p.toleranceFp = 0;
        vm.expectRevert(abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidTolerance.selector, uint256(0)));
        this.callValidateCreation(p);

        p.toleranceFp = 1e18;
        vm.expectRevert(abi.encodeWithSelector(TrustgraphsParamsValidator.InvalidTolerance.selector, uint256(1e18)));
        this.callValidateCreation(p);
    }

    function callValidateCreation(ParamsCodec.Params memory p) external pure {
        TrustgraphsParamsValidator.validateCreation(p);
    }

    function _trustParams() internal pure returns (ParamsCodec.Params memory p) {
        p.dampingFp = 0.85e18;
        p.toleranceFp = 1e12;
        p.maxIterations = 50;
        p.minWeightFp = 0;
        p.maxWeightFp = 100e18;
        p.trustShareFp = 0.5e18;
        p.trustDecayFp = 0.5e18;
        p.trustedSeeds = new address[](1);
        p.trustedSeeds[0] = address(0x5EED1);
        p.totalPool = 1e24;
        p.precisionScale = 1e18;
        p.weightFieldIndex = 1;
    }
}

/// @dev Minimal EAS stand-in: `EasOffchainAnchorRegistry`'s constructor only reads `version()`.
contract EasStub {
    function version() external pure returns (string memory) {
        return "1.3.0";
    }
}
