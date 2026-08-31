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
import {MockZkVerifier} from "../mocks/MockZkVerifier.sol";
import {MockAccumulator} from "../mocks/MockAccumulator.sol";

contract MockSignerSyncCheckpointSource is ISignerSyncCheckpointSource {
    mapping(uint256 => bytes32) public checkpointParamsHash;

    function set(uint256 checkpointId, bytes32 value) external {
        checkpointParamsHash[checkpointId] = value;
    }
}

contract MockSignerActivitySource is ISignerActivitySource {
    bytes32 public activityAccumulator;
    uint64 public activityCount;
    ActivityCheckpoint[] internal checkpoints;

    function push(bytes32 acc_, uint64 count_, uint64 blockNumber_) external {
        activityAccumulator = acc_;
        activityCount = count_;
        checkpoints.push(ActivityCheckpoint(acc_, count_, blockNumber_));
    }

    function getActivityCheckpoint(uint256 id) external view returns (ActivityCheckpoint memory) {
        return checkpoints[id];
    }
}

contract SignerSyncZkModuleTest is Test {
    GnosisSafe internal safeSingleton;
    GnosisSafeProxyFactory internal safeFactory;
    GnosisSafe internal safe;

    SignerSyncZkModule internal module;
    MockZkVerifier internal verifier;
    MockAccumulator internal accumulator;
    MockSignerSyncCheckpointSource internal scoreSnapshot;
    MockSignerActivitySource internal activitySource;

    address internal owner = address(0xABCD);

    // Ascending, non-zero, non-sentinel addresses.
    address internal A = address(0xA1);
    address internal B = address(0xB2);
    address internal C = address(0xC3);
    address internal D = address(0xD4);
    address internal E = address(0xE5);
    address internal F = address(0xF6);

    bytes32 internal constant PARAMS_HASH = keccak256("params");
    bytes32 internal SEL_HASH;
    bytes internal constant PROOF = hex"1234";

    function setUp() public {
        safeSingleton = new GnosisSafe();
        safeFactory = new GnosisSafeProxyFactory();

        // Safe with initial owners {A,B,C}, threshold 2.
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
            payable(address(
                    safeFactory.createProxyWithNonce(address(safeSingleton), setupData, uint256(keccak256("salt")))
                ))
        );

        verifier = new MockZkVerifier();
        accumulator = new MockAccumulator();
        // Two checkpoints available (ids 0 and 1) for monotonicity tests.
        accumulator.pushCheckpoint(keccak256("acc0"), 10, uint64(block.number));
        accumulator.pushCheckpoint(keccak256("acc1"), 20, uint64(block.number));
        scoreSnapshot = new MockSignerSyncCheckpointSource();
        scoreSnapshot.set(0, PARAMS_HASH);
        scoreSnapshot.set(1, PARAMS_HASH);
        activitySource = new MockSignerActivitySource();
        activitySource.push(keccak256("activity"), 2, uint64(block.number));
        SEL_HASH = keccak256(abi.encode(uint32(5), uint32(2), uint32(5000), uint64(151_200), uint32(2)));

        module = new SignerSyncZkModule(
            owner,
            address(safe),
            address(safe),
            IZkVerifier(address(verifier)),
            IAttestationAccumulator(address(accumulator)),
            scoreSnapshot,
            activitySource,
            5,
            2,
            5_000,
            151_200,
            2
        );

        // Enable the module on the Safe (only the Safe itself may enable a module).
        vm.prank(address(safe));
        safe.enableModule(address(module));
    }

    /*//////////////////////// helpers ////////////////////////*/

    function _arr(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _arr(address a, address b) internal pure returns (address[] memory r) {
        r = new address[](2);
        r[0] = a;
        r[1] = b;
    }

    function _arr(address a, address b, address c) internal pure returns (address[] memory r) {
        r = new address[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }

    function _arr(address a, address b, address c, address d) internal pure returns (address[] memory r) {
        r = new address[](4);
        r[0] = a;
        r[1] = b;
        r[2] = c;
        r[3] = d;
    }

    function _arr(address a, address b, address c, address d, address e) internal pure returns (address[] memory r) {
        r = new address[](5);
        r[0] = a;
        r[1] = b;
        r[2] = c;
        r[3] = d;
        r[4] = e;
    }

    function _assertOwnerSet(address[] memory expected, uint256 threshold) internal view {
        address[] memory got = safe.getOwners();
        assertEq(got.length, expected.length, "owner count mismatch");
        for (uint256 i = 0; i < expected.length; i++) {
            assertTrue(safe.isOwner(expected[i]), "expected owner missing");
        }
        assertEq(safe.getThreshold(), threshold, "threshold mismatch");
    }

    function _newModuleWithAccumulator(IAttestationAccumulator accumulator_)
        internal
        returns (SignerSyncZkModule module_)
    {
        module_ = new SignerSyncZkModule(
            owner,
            address(safe),
            address(safe),
            IZkVerifier(address(verifier)),
            accumulator_,
            scoreSnapshot,
            activitySource,
            5,
            2,
            5_000,
            151_200,
            2
        );
    }

    /*//////////////////////// setup / governance ////////////////////////*/

    function test_Setup() public view {
        assertEq(module.avatar(), address(safe));
        assertEq(module.target(), address(safe));
        assertEq(module.owner(), owner);
        assertEq(module.selectionParamsHash(), SEL_HASH);
        assertTrue(safe.isModuleEnabled(address(module)));
    }

    function test_Constructor_ZeroAddressReverts() public {
        vm.expectRevert(SignerSyncZkModule.ZeroAddress.selector);
        new SignerSyncZkModule(
            owner,
            address(0),
            address(safe),
            IZkVerifier(address(verifier)),
            IAttestationAccumulator(address(accumulator)),
            scoreSnapshot,
            activitySource,
            5,
            2,
            5_000,
            151_200,
            2
        );
    }

    function test_Governance_OnlyOwner() public {
        vm.startPrank(address(0xdead));
        vm.expectRevert();
        module.setSelectionParams(5, 2, 5_000, 151_200, 2);
        vm.expectRevert();
        module.setZkVerifier(IZkVerifier(address(0x1234)));
        vm.expectRevert();
        module.setAccumulator(IAttestationAccumulator(address(0x1234)));
        vm.stopPrank();
    }

    function test_Governance_OwnerUpdates() public {
        vm.startPrank(owner);
        module.setSelectionParams(4, 2, 6_000, 100_000, 2);
        vm.stopPrank();
        assertEq(
            module.selectionParamsHash(),
            keccak256(abi.encode(uint32(4), uint32(2), uint32(6000), uint64(100_000), uint32(2)))
        );
    }

    function test_AccumulatorRotationRequiresBothCheckpointHistoriesEmpty() public {
        MockAccumulator emptyCandidate = new MockAccumulator();
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(SignerSyncZkModule.AccumulatorRotationLocked.selector, uint256(2), uint256(0))
        );
        module.setAccumulator(emptyCandidate);
        assertEq(address(module.accumulator()), address(accumulator), "live history was rotated");

        MockAccumulator emptyCurrent = new MockAccumulator();
        SignerSyncZkModule fresh = _newModuleWithAccumulator(emptyCurrent);
        MockAccumulator usedCandidate = new MockAccumulator();
        usedCandidate.pushCheckpoint(keccak256("used"), 1, uint64(block.number));
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(SignerSyncZkModule.AccumulatorRotationLocked.selector, uint256(0), uint256(1))
        );
        fresh.setAccumulator(usedCandidate);
        assertEq(address(fresh.accumulator()), address(emptyCurrent), "pre-used history was adopted");
    }

    function test_AccumulatorRotationBeforeCheckpointClearsHighWaterState() public {
        MockAccumulator emptyCurrent = new MockAccumulator();
        MockAccumulator emptyCandidate = new MockAccumulator();
        SignerSyncZkModule fresh = _newModuleWithAccumulator(emptyCurrent);

        vm.prank(owner);
        fresh.setAccumulator(emptyCandidate);

        assertEq(address(fresh.accumulator()), address(emptyCandidate));
        assertEq(fresh.lastAppliedCheckpoint(), 0, "high-water id not reset");
        assertFalse(fresh.hasAppliedCheckpoint(), "high-water sentinel not reset");
    }

    function test_ReapplyingSameAccumulatorDoesNotEraseAppliedHighWaterMark() public {
        module.submitSignerProof(0, 0, _arr(D, E, F), 2, PROOF);
        assertTrue(module.hasAppliedCheckpoint());

        vm.prank(owner);
        module.setAccumulator(accumulator);

        assertEq(module.lastAppliedCheckpoint(), 0);
        assertTrue(module.hasAppliedCheckpoint(), "same-address no-op erased applied history");
    }

    function test_PauseIsGovernedAndStopsProofs() public {
        vm.expectRevert();
        vm.prank(address(0xdead));
        module.setPaused(true);

        vm.prank(owner);
        module.setPaused(true);
        assertTrue(module.paused());
        vm.expectRevert(SignerSyncZkModule.SignerSyncPaused.selector);
        module.submitSignerProof(0, 0, _arr(D, E, F), 2, PROOF);

        vm.prank(owner);
        module.setPaused(false);
        module.submitSignerProof(0, 0, _arr(D, E, F), 2, PROOF);
    }

    function test_UnpinnedCheckpointRevertsBeforeVerification() public {
        scoreSnapshot.set(0, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(SignerSyncZkModule.UnpinnedCheckpoint.selector, uint256(0)));
        module.submitSignerProof(0, 0, _arr(D, E, F), 2, PROOF);
    }

    function test_ParamsRotationDoesNotInvalidatePinnedCheckpoint() public {
        address[] memory signers = _arr(D, E, F);
        bytes32 expected = _expectedDigest(module, keccak256("acc0"), 10, signers, 2);
        verifier.setExpectedDigest(expected);

        module.submitSignerProof(0, 0, signers, 2, PROOF);
        _assertOwnerSet(signers, 2);
    }

    function test_Rotate_FullSwap() public {
        // {A,B,C} -> {D,E,F} : 3 removes, 3 adds -> 3 swaps, count unchanged.
        module.submitSignerProof(0, 0, _arr(D, E, F), 2, PROOF);
        _assertOwnerSet(_arr(D, E, F), 2);
        assertFalse(safe.isOwner(A));
    }

    function test_Rotate_NetAdd() public {
        // {A,B,C} -> {A,B,C,D,E} : 2 adds, threshold up to 3.
        module.submitSignerProof(0, 0, _arr(A, B, C, D, E), 3, PROOF);
        _assertOwnerSet(_arr(A, B, C, D, E), 3);
    }

    function test_Rotate_NetRemove() public {
        // {A,B,C} -> {A} : 2 removes, threshold down to 1 (invariant preserved throughout).
        module.submitSignerProof(0, 0, _arr(A), 1, PROOF);
        _assertOwnerSet(_arr(A), 1);
        assertFalse(safe.isOwner(B));
        assertFalse(safe.isOwner(C));
    }

    function test_Rotate_MixedSwapOnly() public {
        // {A,B,C} -> {A,D,E} : keep A, swap B->D, C->E.
        module.submitSignerProof(0, 0, _arr(A, D, E), 2, PROOF);
        _assertOwnerSet(_arr(A, D, E), 2);
    }

    function test_Rotate_MixedSwapAndAdd() public {
        // {A,B,C} -> {A,B,D,E,F} : keep A,B; swap C->D; add E,F.
        module.submitSignerProof(0, 0, _arr(A, B, D, E, F), 2, PROOF);
        _assertOwnerSet(_arr(A, B, D, E, F), 2);
    }

    function test_Rotate_MixedSwapAndRemove() public {
        // {A,B,C} -> {A,D} : keep A; swap B->D; remove C. Final count 2.
        module.submitSignerProof(0, 0, _arr(A, D), 1, PROOF);
        _assertOwnerSet(_arr(A, D), 1);
    }

    function test_Rotate_NoMemberChange_ThresholdOnly() public {
        // Same set, lower threshold 2 -> 1.
        module.submitSignerProof(0, 0, _arr(A, B, C), 1, PROOF);
        _assertOwnerSet(_arr(A, B, C), 1);
    }

    function test_Rotate_SequentialCheckpoints() public {
        module.submitSignerProof(0, 0, _arr(A, D), 1, PROOF);
        _assertOwnerSet(_arr(A, D), 1);
        // Second, higher checkpoint rotates again from the new state.
        module.submitSignerProof(1, 0, _arr(A, B, C, D), 2, PROOF);
        _assertOwnerSet(_arr(A, B, C, D), 2);
    }

    /*//////////////////////// guards ////////////////////////*/

    function test_StaleCheckpointReverts() public {
        module.submitSignerProof(1, 0, _arr(D, E, F), 2, PROOF);
        vm.expectRevert(abi.encodeWithSelector(SignerSyncZkModule.StaleCheckpoint.selector, uint256(1), uint256(1)));
        module.submitSignerProof(1, 0, _arr(A, B, C), 2, PROOF);
        // A strictly-lower checkpoint is also stale.
        vm.expectRevert(abi.encodeWithSelector(SignerSyncZkModule.StaleCheckpoint.selector, uint256(0), uint256(1)));
        module.submitSignerProof(0, 0, _arr(A, B, C), 2, PROOF);
    }

    function test_EmptySignerSetReverts() public {
        address[] memory empty = new address[](0);
        vm.expectRevert(SignerSyncZkModule.EmptySignerSet.selector);
        module.submitSignerProof(0, 0, empty, 1, PROOF);
    }

    function test_NonAscendingReverts() public {
        vm.expectRevert(SignerSyncZkModule.SignersNotStrictlyAscending.selector);
        module.submitSignerProof(0, 0, _arr(B, A), 1, PROOF);
    }

    function test_DuplicateReverts() public {
        vm.expectRevert(SignerSyncZkModule.SignersNotStrictlyAscending.selector);
        module.submitSignerProof(0, 0, _arr(A, A), 1, PROOF);
    }

    function test_ZeroAndSentinelSignerRevert() public {
        vm.expectRevert(abi.encodeWithSelector(SignerSyncZkModule.InvalidSigner.selector, address(0)));
        module.submitSignerProof(0, 0, _arr(address(0)), 1, PROOF);

        vm.expectRevert(abi.encodeWithSelector(SignerSyncZkModule.InvalidSigner.selector, address(0x1)));
        module.submitSignerProof(0, 0, _arr(address(0x1)), 1, PROOF);
    }

    function test_InvalidThresholdReverts() public {
        vm.expectRevert(abi.encodeWithSelector(SignerSyncZkModule.InvalidThreshold.selector, uint256(0), uint256(3)));
        module.submitSignerProof(0, 0, _arr(A, B, C), 0, PROOF);

        vm.expectRevert(abi.encodeWithSelector(SignerSyncZkModule.InvalidThreshold.selector, uint256(4), uint256(3)));
        module.submitSignerProof(0, 0, _arr(A, B, C), 4, PROOF);
    }

    function test_RejectedProofReverts() public {
        verifier.setAccept(false);
        vm.expectRevert(bytes("MockZkVerifier: rejected"));
        module.submitSignerProof(0, 0, _arr(D, E, F), 2, PROOF);
    }

    /*//////////////////////// fuzz: owner diff always lands on desired ////////////////////////*/

    /// @dev For any non-empty target subset of the ascending pool {A..F} and any valid threshold, the
    ///      diff must leave the Safe holding EXACTLY that set with that threshold, never reverting
    ///      (i.e. the 1<=threshold<=ownerCount invariant holds at every intermediate step).
    function testFuzz_DiffLandsOnDesired(uint8 mask, uint256 thresholdSeed) public {
        address[6] memory pool = [A, B, C, D, E, F];
        // Build the desired set from the low 6 bits of mask, preserving ascending order.
        uint256 count;
        for (uint256 i = 0; i < 6; i++) {
            if (mask & (uint8(1) << uint8(i)) != 0) count++;
        }
        vm.assume(count > 0);
        address[] memory desired = new address[](count);
        uint256 j;
        for (uint256 i = 0; i < 6; i++) {
            if (mask & (uint8(1) << uint8(i)) != 0) desired[j++] = pool[i];
        }
        uint256 threshold = bound(thresholdSeed, 1, count);
        vm.assume(_ozRoot(desired) != _ozRoot(safe.getOwners()) || threshold != safe.getThreshold());

        module.submitSignerProof(0, 0, desired, threshold, PROOF);
        _assertOwnerSet(desired, threshold);
    }

    /*//////////////////////// journal digest binding ////////////////////////*/

    /// @dev The exact digest `submitSignerProof` rebuilds for `mod_` on the current chain: the
    ///      frozen 13-word signer journal, whose final word is the M-3 instance/chain binding.
    function _expectedDigest(
        SignerSyncZkModule mod_,
        bytes32 acc,
        uint64 leafCount,
        address[] memory signers,
        uint256 threshold
    ) internal view returns (bytes32) {
        ISignerActivitySource.ActivityCheckpoint memory activity = activitySource.getActivityCheckpoint(0);
        return keccak256(
            abi.encode(
                acc,
                leafCount,
                // The digest binds the snapshot's checkpoint-pinned params hash; every mock
                // checkpoint in this suite pins PARAMS_HASH.
                PARAMS_HASH,
                mod_.selectionParamsHash(),
                activity.acc,
                activity.count,
                activity.blockNumber,
                mod_.hasAppliedCheckpoint(),
                _ozRoot(safe.getOwners()),
                safe.getThreshold(),
                _ozRoot(signers),
                threshold,
                keccak256(abi.encode(address(mod_), block.chainid))
            )
        );
    }

    function test_JournalDigestBinding() public {
        // Lock the exact on-chain signer-journal encoding: the verifier is told to require the digest
        // the module rebuilds, so the encode() order/types are asserted.
        address[] memory signers = _arr(D, E, F);
        bytes32 expected = _expectedDigest(module, keccak256("acc0"), 10, signers, 2);
        verifier.setExpectedDigest(expected);
        module.submitSignerProof(0, 0, signers, 2, PROOF);
        _assertOwnerSet(signers, 2);
    }

    function test_JournalDigest_WrongParamsFails() public {
        // The checkpoint pins PARAMS_HASH; a proof made for any other tuple still fails.
        address[] memory signers = _arr(D, E, F);
        bytes32 signerSetRoot = _ozRoot(signers);
        bytes32 madeForDifferentParams = keccak256(
            abi.encode(
                keccak256("acc0"),
                uint64(10),
                keccak256("OTHER"),
                SEL_HASH,
                activitySource.activityAccumulator(),
                activitySource.activityCount(),
                uint64(block.number),
                false,
                _ozRoot(safe.getOwners()),
                safe.getThreshold(),
                signerSetRoot,
                uint256(2),
                keccak256(abi.encode(address(module), block.chainid))
            )
        );
        verifier.setExpectedDigest(madeForDifferentParams);
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        module.submitSignerProof(0, 0, signers, 2, PROOF);
    }

    /*//////////////////////// M-3: instance/chain binding ////////////////////////*/

    /// @dev Audit M-3 regression: two same-params modules sharing one accumulator must NOT accept
    ///      each other's owner-rotation proofs. A proof made for `module` (its digest carries
    ///      module's address) fails verification on a sibling module, even with identical
    ///      paramsHash/selectionParamsHash/checkpoint/signer set.
    function test_M3_CrossInstanceReplayRejected() public {
        SignerSyncZkModule sibling = new SignerSyncZkModule(
            owner,
            address(safe),
            address(safe),
            IZkVerifier(address(verifier)),
            IAttestationAccumulator(address(accumulator)),
            scoreSnapshot,
            activitySource,
            5,
            2,
            5_000,
            151_200,
            2
        );
        vm.prank(address(safe));
        safe.enableModule(address(sibling));

        address[] memory signers = _arr(D, E, F);
        // The proof that exists in the wild was made for `module`.
        verifier.setExpectedDigest(_expectedDigest(module, keccak256("acc0"), 10, signers, 2));

        // Replaying it against the sibling module fails: the sibling rebuilds the domain word from
        // ITS OWN address, producing a digest the proof does not verify against.
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        sibling.submitSignerProof(0, 0, signers, 2, PROOF);

        // The module it was made for still accepts it.
        module.submitSignerProof(0, 0, signers, 2, PROOF);
        _assertOwnerSet(signers, 2);
    }

    /// @dev Audit M-3 regression: a module mirrored at the SAME address on another chain (CREATE2)
    ///      must not accept a proof made for this chain — the domain word commits block.chainid.
    ///      (Positive control first: this foundry version does not honor a second vm.chainId call
    ///      within one test, so the chain switch is one-way.)
    function test_M3_CrossChainReplayRejected() public {
        address[] memory signers = _arr(D, E, F);

        // Sanity: the proof verifies on the chain it was made for (the test chain, 31337).
        verifier.setExpectedDigest(_expectedDigest(module, keccak256("acc0"), 10, signers, 2));
        module.submitSignerProof(0, 0, signers, 2, PROOF);
        _assertOwnerSet(signers, 2);

        // A second proof also made for chain 31337 (digest computed BEFORE the switch) ...
        address[] memory next = _arr(A, B, C);
        verifier.setExpectedDigest(_expectedDigest(module, keccak256("acc1"), 20, next, 2));

        // ... is rejected by the mirrored deployment on chain 1: the module rebuilds the domain
        // word from ITS chain id, producing a digest the proof does not verify against.
        vm.chainId(1);
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        module.submitSignerProof(1, 0, next, 2, PROOF);
    }

    /// @dev Mirror of the module/pagerank-core OZ root (leaf = keccak256(abi.encode(address))).
    function _ozRoot(address[] memory signers) internal pure returns (bytes32) {
        uint256 n = signers.length;
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            leaves[i] = keccak256(abi.encode(signers[i]));
        }
        for (uint256 i = 1; i < n; i++) {
            bytes32 key = leaves[i];
            uint256 j = i;
            while (j > 0 && leaves[j - 1] > key) {
                leaves[j] = leaves[j - 1];
                j--;
            }
            leaves[j] = key;
        }
        if (n == 1) return leaves[0];
        uint256 size = 2 * n - 1;
        bytes32[] memory tree = new bytes32[](size);
        for (uint256 i = 0; i < n; i++) {
            tree[size - 1 - i] = leaves[i];
        }
        for (uint256 i = n - 1; i > 0; i--) {
            uint256 idx = i - 1;
            bytes32 a = tree[2 * idx + 1];
            bytes32 b = tree[2 * idx + 2];
            tree[idx] = a <= b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
        }
        return tree[0];
    }
}
