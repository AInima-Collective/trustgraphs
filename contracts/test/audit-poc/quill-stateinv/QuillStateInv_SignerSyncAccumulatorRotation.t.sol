// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

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
/// `MerkleSnapshot.setAccumulator` enforces exactly that by refusing any rotation once a
/// checkpoint exists. `SignerSyncZkModule.setAccumulator` has no such lock and never resets
/// the high-water mark, so the id space can be swapped underneath a live mark.
contract QuillStateInv_SignerSyncAccumulatorRotation is Test {
    GnosisSafe internal safeSingleton;
    GnosisSafeProxyFactory internal safeFactory;
    GnosisSafe internal safe;

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
        safeSingleton = new GnosisSafe();
        safeFactory = new GnosisSafeProxyFactory();
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
        safe = GnosisSafe(
            payable(
                address(safeFactory.createProxyWithNonce(address(safeSingleton), setupData, uint256(keccak256("q"))))
            )
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
            PARAMS_HASH,
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

    function test_HighWaterMarkSurvivesAccumulatorRotation_WedgesModule() public {
        (address[] memory signers, uint256 threshold) = _noopSet();

        // 1. Apply checkpoint 3 of accumulator A. High-water mark = 3.
        module.submitSignerProof(3, 0, signers, threshold, PROOF);
        assertEq(module.lastAppliedCheckpoint(), 3, "high-water mark not set");
        assertTrue(module.hasAppliedCheckpoint());

        // 2. Governance rotates the accumulator to a FRESH one (id space restarts at 0).
        //    `MerkleSnapshot.setAccumulator` would revert `AccumulatorRotationLocked` here;
        //    this module accepts it unconditionally.
        MockAccumulator accB = new MockAccumulator();
        accB.pushCheckpoint(keccak256("b0"), 5, uint64(block.number));
        vm.prank(owner);
        module.setAccumulator(IAttestationAccumulator(address(accB)));

        // 3. The high-water mark was NOT reset, so it now indexes a different contract's ids.
        assertEq(module.lastAppliedCheckpoint(), 3, "mark should have been reset by the rotation");

        // Every id accB actually has is <= the stale mark and is refused as stale ...
        vm.expectRevert(abi.encodeWithSelector(SignerSyncZkModule.StaleCheckpoint.selector, 0, 3));
        module.submitSignerProof(0, 0, signers, threshold, PROOF);

        // ... and every id above the stale mark is out of range on accB, so the call reverts on
        // the raw array access. The module can rotate no owners at all until accB independently
        // mints 4 checkpoints. Owner rotation is dead in the meantime.
        vm.expectRevert();
        module.submitSignerProof(4, 0, signers, threshold, PROOF);
    }

    function test_RotationSilentlySkipsIdsAndMixesTwoCheckpointHistories() public {
        (address[] memory signers, uint256 threshold) = _noopSet();
        module.submitSignerProof(1, 0, signers, threshold, PROOF);
        assertEq(module.lastAppliedCheckpoint(), 1);

        // A replacement accumulator with a LONGER history: nothing forces it to be the same
        // accumulator `scoreSnapshot` pinned params for.
        MockAccumulator accB = new MockAccumulator();
        for (uint256 i; i < 6; ++i) {
            accB.pushCheckpoint(keccak256(abi.encode("b", i)), uint64(100 + i), uint64(block.number));
        }
        vm.prank(owner);
        module.setAccumulator(IAttestationAccumulator(address(accB)));

        // Checkpoint id 2 now means accB's third entry, while `scoreSnapshot.checkpointParamsHash(2)`
        // still describes the SCORE snapshot's checkpoint 2 - a different freeze of different
        // inputs. The contract accepts the pair with no consistency check whatsoever.
        module.submitSignerProof(2, 0, signers, threshold, PROOF);
        assertEq(module.lastAppliedCheckpoint(), 2);
        assertEq(accB.getCheckpoint(2).leafCount, 102, "proof was bound to the replacement history");
        // Nothing on the module ties `accumulator` to the accumulator `scoreSnapshot` reads.
        assertTrue(address(module.accumulator()) == address(accB));
    }
}
