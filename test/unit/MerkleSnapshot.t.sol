// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {MockZkVerifier} from "../mocks/MockZkVerifier.sol";
import {MockAccumulator} from "../mocks/MockAccumulator.sol";
import {MockHook} from "../mocks/MockHook.sol";

contract MerkleSnapshotTest is Test {
    MerkleSnapshot ms;
    MockZkVerifier verifier;
    MockAccumulator accer;

    address constitutional = address(0xC047);
    address operational = address(0x0BE7);
    bytes32 paramsHash = keccak256("params-v1");

    // sample proof outputs
    bytes32 constant ROOT = bytes32(uint256(0xC0FFEE));
    bytes32 constant IPFS = bytes32(uint256(0x1F5));
    string constant CID = "bafkreiexamplecidstring";
    uint256 constant TOTAL = 1_000_000 ether;

    function setUp() public {
        verifier = new MockZkVerifier();
        accer = new MockAccumulator();
        ms = new MerkleSnapshot(verifier, paramsHash, accer, constitutional, operational);
    }

    function _expectDigest(bytes32 acc, uint64 leafCount) internal {
        bytes32 digest = keccak256(
            abi.encode(acc, leafCount, paramsHash, ROOT, IPFS, keccak256(bytes(CID)), TOTAL)
        );
        verifier.setExpectedDigest(digest);
    }

    function _submit(uint256 checkpointId) internal {
        ms.submitProof(checkpointId, ROOT, IPFS, CID, TOTAL, hex"");
    }

    function test_TriggerCreatesCheckpoint() public {
        accer.setState(bytes32(uint256(1)), 3);
        uint256 id = ms.trigger();
        assertEq(id, 0);
        assertEq(accer.checkpointCount(), 1);
    }

    function test_SubmitProofHappyPath() public {
        bytes32 acc = bytes32(uint256(0xABCD));
        accer.pushCheckpoint(acc, 5, 42);
        _expectDigest(acc, 5);

        _submit(0);

        IMerkleSnapshot.MerkleState memory s = ms.getLatestState();
        assertEq(s.root, ROOT);
        assertEq(s.blockNumber, 42, "must file at the checkpoint freeze block");
        assertEq(s.totalValue, TOTAL);
        assertEq(ms.lastAppliedCheckpoint(), 0);
        assertTrue(ms.hasAppliedCheckpoint());
    }

    function test_SubmitProofRevertsOnInvalidProof() public {
        accer.pushCheckpoint(bytes32(uint256(1)), 1, 10);
        verifier.setAccept(false);
        vm.expectRevert(bytes("MockZkVerifier: rejected"));
        _submit(0);
    }

    function test_SubmitProofBindsWrongJournalReverts() public {
        accer.pushCheckpoint(bytes32(uint256(1)), 1, 10);
        // Expect a digest for the WRONG leafCount; the contract's real digest won't match.
        _expectDigest(bytes32(uint256(1)), 999);
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        _submit(0);
    }

    function test_StaleCheckpointRejected() public {
        accer.pushCheckpoint(bytes32(uint256(1)), 1, 10); // id 0
        accer.pushCheckpoint(bytes32(uint256(2)), 2, 20); // id 1
        _submit(1); // apply newer first
        // Applying an older one now is stale.
        vm.expectRevert(
            abi.encodeWithSelector(IMerkleSnapshot.StaleCheckpoint.selector, uint256(0), uint256(1))
        );
        _submit(0);
        // Re-applying the same is also stale.
        vm.expectRevert(
            abi.encodeWithSelector(IMerkleSnapshot.StaleCheckpoint.selector, uint256(1), uint256(1))
        );
        _submit(1);
    }

    function test_MonotonicIncreasingAllowed() public {
        accer.pushCheckpoint(bytes32(uint256(1)), 1, 10);
        accer.pushCheckpoint(bytes32(uint256(2)), 2, 20);
        _submit(0);
        _submit(1);
        assertEq(ms.lastAppliedCheckpoint(), 1);
    }

    function test_FreezeBlockFilingKeepsBlocksAscending() public {
        accer.pushCheckpoint(bytes32(uint256(1)), 1, 42);
        accer.pushCheckpoint(bytes32(uint256(2)), 2, 100);
        _submit(0);
        _submit(1);
        assertEq(ms.getStateCount(), 2);
        // binary search by block still works
        assertEq(ms.getStateAtBlock(42).blockNumber, 42);
        assertEq(ms.getStateAtBlock(100).blockNumber, 100);
        assertEq(ms.getStateAtBlock(70).blockNumber, 42, "at-or-before lookup");
    }

    function test_EmptyCheckpointProvable() public {
        accer.pushCheckpoint(bytes32(0), 0, 7);
        bytes32 digest = keccak256(
            abi.encode(bytes32(0), uint64(0), paramsHash, bytes32(0), bytes32(0), keccak256(bytes("")), uint256(0))
        );
        verifier.setExpectedDigest(digest);
        ms.submitProof(0, bytes32(0), bytes32(0), "", 0, hex"");
        assertEq(ms.getLatestState().blockNumber, 7);
    }

    function test_HooksFireOnSubmit() public {
        MockHook hook = new MockHook();
        vm.prank(constitutional);
        ms.addHook(hook);

        accer.pushCheckpoint(bytes32(uint256(1)), 1, 10);
        _submit(0);
        assertEq(hook.calls(), 1);
        assertEq(hook.lastRoot(), ROOT);
    }

    function test_OnlyConstitutionalCanSetVerifier() public {
        vm.expectRevert();
        vm.prank(operational);
        ms.setZkVerifier(verifier);

        vm.prank(constitutional);
        ms.setZkVerifier(verifier); // ok
    }

    function test_OnlyOperationalCanSetParams() public {
        vm.expectRevert();
        vm.prank(address(0xdead));
        ms.setParamsHash(bytes32(uint256(9)));

        vm.prank(operational);
        ms.setParamsHash(bytes32(uint256(9)));
        assertEq(ms.paramsHash(), bytes32(uint256(9)));
    }

    function test_ConstructorRejectsZeroVerifierOrAccumulator() public {
        vm.expectRevert(IMerkleSnapshot.ZeroAddress.selector);
        new MerkleSnapshot(MockZkVerifier(address(0)), paramsHash, accer, constitutional, operational);

        vm.expectRevert(IMerkleSnapshot.ZeroAddress.selector);
        new MerkleSnapshot(verifier, paramsHash, MockAccumulator(address(0)), constitutional, operational);
    }

    function test_SetZeroVerifierReverts() public {
        vm.prank(constitutional);
        vm.expectRevert(IMerkleSnapshot.ZeroAddress.selector);
        ms.setZkVerifier(MockZkVerifier(address(0)));
    }

    function test_ConstitutionalAdminsOperationalRole() public {
        bytes32 cRole = ms.CONSTITUTIONAL_ROLE();
        bytes32 oRole = ms.OPERATIONAL_ROLE();

        // operational cannot grant itself constitutional
        vm.prank(operational);
        vm.expectRevert();
        ms.grantRole(cRole, operational);

        // constitutional can rotate the operational role (e.g. to the gov module)
        vm.prank(constitutional);
        ms.grantRole(oRole, address(0xF00D));
        assertTrue(ms.hasRole(oRole, address(0xF00D)));
    }
}
