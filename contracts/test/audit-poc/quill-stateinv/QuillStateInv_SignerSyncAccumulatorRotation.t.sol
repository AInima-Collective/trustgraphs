// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {Safe} from "@safe-global/safe-smart-account/Safe.sol";
import {SafeProxyFactory} from "@safe-global/safe-smart-account/proxies/SafeProxyFactory.sol";

import {
    SignerSyncZkModule,
    ISignerSyncCheckpointSource,
    ISignerActivitySource
} from "src/zodiac/SignerSyncZkModule.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {MockZkVerifier} from "test/mocks/MockZkVerifier.sol";
import {MockAccumulator} from "test/mocks/MockAccumulator.sol";

contract QuillCheckpointSource is ISignerSyncCheckpointSource, ISignerActivitySource {
    mapping(uint256 => bytes32) public checkpointParamsHash;
    bytes32 public activityAccumulator = keccak256("activity");
    uint64 public activityCount = 2;

    function set(uint256 checkpointId, bytes32 value) external {
        checkpointParamsHash[checkpointId] = value;
    }

    function getActivityCheckpoint(uint256) external view returns (ActivityCheckpoint memory) {
        return ActivityCheckpoint(activityAccumulator, activityCount, uint64(block.number));
    }
}

/// @notice state-invariant-detection PoC.
///
/// Invariant under test (Type 4, monotonic ordering):
///   `lastAppliedCheckpoint` is a high-water mark over the id space of `accumulator`.
///   It is only meaningful while `accumulator` is the SAME contract whose ids it counted.
///
/// `SignerSyncZkModule.setAccumulator` now mirrors `MerkleSnapshot`: both current and candidate
/// histories must be empty. Thus an applied high-water mark can never be interpreted in a new id
/// space, and the only permitted rotation explicitly restores the empty high-water state.
contract QuillStateInv_SignerSyncAccumulatorRotation is Test {
    Safe internal safeSingleton;
    SafeProxyFactory internal safeFactory;
    Safe internal safe;

    SignerSyncZkModule internal module;
    MockZkVerifier internal verifier;
    MockAccumulator internal accA;
    QuillCheckpointSource internal scoreSnapshot;

    address internal owner = address(0xABCD);
    address internal A = address(0xA1);
    address internal B = address(0xB2);
    address internal C = address(0xC3);

    bytes32 internal constant PARAMS_HASH = keccak256("params");
    bytes32 internal constant SEL_HASH = keccak256("selection");
    bytes internal constant PROOF = hex"1234";

    function setUp() public {
        safeSingleton = new Safe();
        safeFactory = new SafeProxyFactory();
        address[] memory initial = new address[](3);
        initial[0] = A;
        initial[1] = B;
        initial[2] = C;
        bytes memory setupData = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            initial,
            2,
            address(0),
            "",
            address(0),
            address(0),
            0,
            address(0)
        );
        safe = Safe(
            payable(address(
                    safeFactory.createProxyWithNonce(address(safeSingleton), setupData, uint256(keccak256("q")))
                ))
        );

        verifier = new MockZkVerifier();
        accA = new MockAccumulator();
        // Accumulator A grows a real history: ids 0..3.
        accA.pushCheckpoint(keccak256("a0"), 10, uint64(block.number));
        accA.pushCheckpoint(keccak256("a1"), 20, uint64(block.number));
        accA.pushCheckpoint(keccak256("a2"), 30, uint64(block.number));
        accA.pushCheckpoint(keccak256("a3"), 40, uint64(block.number));

        scoreSnapshot = new QuillCheckpointSource();
        for (uint256 i; i < 8; ++i) {
            scoreSnapshot.set(i, PARAMS_HASH);
        }

        module = new SignerSyncZkModule(
            owner,
            address(safe),
            address(safe),
            IZkVerifier(address(verifier)),
            IAttestationAccumulator(address(accA)),
            scoreSnapshot,
            scoreSnapshot,
            5,
            2,
            5_000,
            151_200,
            2
        );
        vm.prank(address(safe));
        safe.enableModule(address(module));
    }

    /// Desired == current owner set and threshold, so `_syncOwners` performs no Safe ops.
    function _noopSet() internal view returns (address[] memory signers, uint256 threshold) {
        signers = new address[](3);
        signers[0] = A;
        signers[1] = B;
        signers[2] = C;
        threshold = safe.getThreshold();
    }

    function test_HighWaterMarkLocksAccumulatorRotation() public {
        (address[] memory signers, uint256 threshold) = _noopSet();

        // 1. Apply checkpoint 3 of accumulator A. High-water mark = 3.
        module.submitSignerProof(3, 0, signers, threshold, PROOF);
        assertEq(module.lastAppliedCheckpoint(), 3, "high-water mark not set");
        assertTrue(module.hasAppliedCheckpoint());

        // 2. Governance cannot rotate to a fresh id space after history exists.
        MockAccumulator accB = new MockAccumulator();
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(SignerSyncZkModule.AccumulatorRotationLocked.selector, uint256(4), uint256(0))
        );
        module.setAccumulator(IAttestationAccumulator(address(accB)));

        // 3. The binding and its high-water mark remain one coherent history.
        assertEq(address(module.accumulator()), address(accA));
        assertEq(module.lastAppliedCheckpoint(), 3);
        assertTrue(module.hasAppliedCheckpoint());
    }

    function test_UsedCandidateCannotMixCheckpointHistories() public {
        (address[] memory signers, uint256 threshold) = _noopSet();
        module.submitSignerProof(1, 0, signers, threshold, PROOF);
        assertEq(module.lastAppliedCheckpoint(), 1);

        // A replacement accumulator with a longer, unrelated history is rejected too. Checking
        // both sides closes the pre-seeded-candidate path, not merely rotations after apply.
        MockAccumulator accB = new MockAccumulator();
        for (uint256 i; i < 6; ++i) {
            accB.pushCheckpoint(keccak256(abi.encode("b", i)), uint64(100 + i), uint64(block.number));
        }
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(SignerSyncZkModule.AccumulatorRotationLocked.selector, uint256(4), uint256(6))
        );
        module.setAccumulator(IAttestationAccumulator(address(accB)));

        // The next proof therefore remains tied to accumulator A and its score-snapshot id space.
        module.submitSignerProof(2, 0, signers, threshold, PROOF);
        assertEq(module.lastAppliedCheckpoint(), 2);
        assertEq(address(module.accumulator()), address(accA));
        assertEq(accA.getCheckpoint(2).leafCount, 30, "proof left the original history");
    }
}
