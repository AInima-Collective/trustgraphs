// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {CompositionSourceAccumulator} from "src/composition/CompositionSourceAccumulator.sol";
import {ICompositionSourceAdapterFactory} from "interfaces/composition/ICompositionSourceAdapter.sol";

/// @notice INVARIANT under attack: `MerkleSnapshot.trigger()` claims "Refuse to freeze a
///         checkpoint identical to the last one, across BOTH lanes ... Without this combined
///         guard, `trigger()` could mint an unlimited run of checkpoints with byte-identical
///         commitments ... and a stale root re-filed at ever-later blocks as if its inputs were
///         fresh."
///
///         The guard compares `accumulator.acc()` (live) against the previous checkpoint's frozen
///         `acc`. `CompositionSourceAccumulator._capture()` folds `uint64(block.number)` into the
///         TGCM header, so its `acc()` changes every block whether or not a single source moved.
///         The guard is therefore structurally unreachable on every `trust-compose` instance.
contract PashovInv_ComposeCaptureFreshness is Test {
    CompositionSourceAccumulator acc;

    function setUp() public {
        // The factory address is only consulted while validating a policy; the capture path
        // never touches it, so a placeholder is enough to exercise `acc()` / `_capture()`.
        acc = new CompositionSourceAccumulator(ICompositionSourceAdapterFactory(address(0xFAC)), address(this));
    }

    function test_CaptureDigestMovesEveryBlockWithNoSourceOrPolicyChange() public {
        vm.roll(1_000);
        bytes32 first = acc.acc();
        bytes memory firstManifest = acc.currentCaptureManifest();

        // Nothing at all changes: no policy install, no source publishes, no adapter rotation.
        vm.roll(1_001);
        bytes32 second = acc.acc();
        bytes memory secondManifest = acc.currentCaptureManifest();

        assertTrue(first != second, "capture digest is supposed to be a function of the INPUTS");
        assertEq(acc.leafCount(), 0);
        assertEq(acc.policyCount(), 0);

        // The difference is the block number the header carries, at bytes [14, 6):
        //   magic(4) || manifestVersion(2) || chainId(8) || blockNumber(8) || sourceCount(1)
        // Those 8 bytes precede every per-source record, so the digest drifts for ANY policy.
        assertEq(_readU64(firstManifest, 14), 1_000);
        assertEq(_readU64(secondManifest, 14), 1_001);

        // Every other header byte is identical.
        for (uint256 i; i < 14; ++i) {
            assertEq(firstManifest[i], secondManifest[i], "non-block header byte moved");
        }
        assertEq(firstManifest[22], secondManifest[22], "source count moved");
        assertEq(firstManifest.length, 23);
    }

    function _readU64(bytes memory data, uint256 offset) internal pure returns (uint64 value) {
        for (uint256 i; i < 8; ++i) {
            value = (value << 8) | uint8(data[offset + i]);
        }
    }
}
