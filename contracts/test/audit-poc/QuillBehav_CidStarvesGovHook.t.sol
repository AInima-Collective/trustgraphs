// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {MerkleGovModule} from "src/zodiac/MerkleGovModule.sol";
import {Operation} from "@gnosis-guild/zodiac-core/core/Operation.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IMerkleSnapshotHook} from "interfaces/merkle/IMerkleSnapshotHook.sol";
import {MockAccumulator} from "test/mocks/MockAccumulator.sol";
import {MockZkVerifier} from "test/mocks/MockZkVerifier.sol";

/// @notice `MerkleSnapshot` puts no length bound on the proven `ipfsHashCid` string, stores it in
///         `states[...]`, and hands the whole `MerkleState` to every hook under a fixed
///         `HOOK_GAS_STIPEND` of 500k. A long CID makes `MerkleGovModule.onMerkleUpdate`'s own
///         `ipfsHashCid` write exceed the stipend, so the hook is caught and skipped: the root
///         lands, the module never learns about it, and `propose` keeps reverting `NoMerkleRootSet`.
contract QuillBehav_CidStarvesGovHook is Test {
    MerkleSnapshot internal snapshot;
    MockAccumulator internal acc;
    MerkleGovModule internal module;

    function setUp() public {
        acc = new MockAccumulator();
        snapshot = new MerkleSnapshot(
            new MockZkVerifier(),
            keccak256("params"),
            IAttestationAccumulator(address(acc)),
            address(this),
            address(this)
        );
        module = new MerkleGovModule(address(this), address(this), address(this), address(snapshot));
        snapshot.addHook(IMerkleSnapshotHook(address(module)));
        assertEq(module.currentMerkleRoot(), bytes32(0), "module starts with no root");
    }

    function _longCid(uint256 length) internal pure returns (string memory) {
        bytes memory b = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            b[i] = bytes1(uint8(97 + (i % 26)));
        }
        return string(b);
    }

    function _land(bytes32 root, string memory cid, uint256 total) internal {
        acc.setState(keccak256(abi.encode(root)), uint64(uint256(root)));
        uint256 id = snapshot.trigger();
        snapshot.submitProof(id, root, keccak256("blob"), cid, total, bytes32(0), address(0xFEE), hex"");
    }

    function _sawHookFailed(Vm.Log[] memory logs) internal view returns (bool) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter == address(snapshot) && logs[i].topics.length == 3
                    && logs[i].topics[0] == MerkleSnapshot.HookFailed.selector
            ) {
                return true;
            }
        }
        return false;
    }

    /// @dev Separate frame: the empty proposal arrays are only here to reach the first check.
    function _expectProposeDead() internal {
        address[] memory targets = new address[](0);
        uint256[] memory values = new uint256[](0);
        bytes[] memory calldatas = new bytes[](0);
        Operation[] memory ops = new Operation[](0);
        string[] memory descs = new string[](0);
        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert(MerkleGovModule.NoMerkleRootSet.selector);
        module.propose("t", "d", targets, values, calldatas, ops, descs, 1, proof);
    }

    function test_LongProvenCidPermanentlySkipsTheGovernanceHook() public {
        // A CID string long enough that the module's own storage write blows the 500k stipend.
        vm.recordLogs();
        _land(bytes32(uint256(1)), _longCid(2_000), 1_000e18);
        assertTrue(_sawHookFailed(vm.getRecordedLogs()), "the snapshot skipped the governance hook");

        // The root is on chain...
        assertEq(snapshot.getLatestState().root, bytes32(uint256(1)), "root landed");
        // ...but governance never received it, so no proposal can be created at all.
        assertEq(module.currentMerkleRoot(), bytes32(0), "module is still root-less");
        assertEq(module.totalVotingPower(), 0, "module has no voting power");
        _expectProposeDead();

        // Control: a normal-length CID updates the module, so the length is the whole mechanism.
        _land(bytes32(uint256(2)), "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", 2_000e18);
        assertEq(module.currentMerkleRoot(), bytes32(uint256(2)), "control root reached the module");
    }
}
