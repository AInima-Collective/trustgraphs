// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleSnapshotHook} from "interfaces/merkle/IMerkleSnapshotHook.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {MockAccumulator} from "test/mocks/MockAccumulator.sol";
import {MockZkVerifier} from "test/mocks/MockZkVerifier.sol";

/// @notice Burns every wei of gas it is given.
contract BurnAllGasHook is IMerkleSnapshotHook {
    function onMerkleUpdate(IMerkleSnapshot.MerkleState memory) external pure {
        uint256 i;
        while (true) {
            unchecked {
                i++;
            }
            keccak256(abi.encode(i));
        }
    }
}

/// @notice Succeeds, but returns a large blob. Tests whether the try/catch success path copies it.
contract ReturnBombHook {
    fallback() external {
        assembly {
            mstore(600000, 0)
            return(0, 600000)
        }
    }
}

contract QuillExtCall_SnapshotHookStipend is Test {
    MerkleSnapshot internal snapshot;
    MockAccumulator internal accumulator;
    MockZkVerifier internal verifier;

    function setUp() public {
        accumulator = new MockAccumulator();
        verifier = new MockZkVerifier();
        snapshot = new MerkleSnapshot(
            IZkVerifier(address(verifier)),
            keccak256("params"),
            IAttestationAccumulator(address(accumulator)),
            address(this),
            address(this)
        );
    }

    function _land(uint256 nonce) internal returns (uint256 gasUsed) {
        accumulator.setState(keccak256(abi.encode("acc", nonce)), uint64(nonce + 1));
        vm.roll(block.number + 10);
        uint256 id = snapshot.trigger();
        uint256 g = gasleft();
        snapshot.submitProof(
            id, keccak256(abi.encode("root", nonce)), sha256("blob"), "bafk-cid", 1000, bytes32(0), address(0), ""
        );
        gasUsed = g - gasleft();
    }

    /// The `{gas: HOOK_GAS_STIPEND}` option is a real CAP as long as the transaction is funded:
    /// EIP-150 only reduces the callee's allowance below the cap when the caller is already low on
    /// gas, and the try/catch converts the callee's OOG into a `HookFailed` event.
    function test_StipendCapsAGasGuzzlingHookAndSubmitProofStillLands() public {
        uint256 baseline = _land(0);
        emit log_named_uint("submitProof gas, no hooks", baseline);

        BurnAllGasHook guzzler = new BurnAllGasHook();
        snapshot.addHook(IMerkleSnapshotHook(address(guzzler)));

        uint256 withHook = _land(1);
        emit log_named_uint("submitProof gas, 1 guzzling hook", withHook);
        emit log_named_uint("delta", withHook - baseline);

        assertEq(snapshot.getLatestState().root, keccak256(abi.encode("root", uint256(1))), "root still landed");
        // The whole cost of a hostile hook is bounded by the stipend plus call overhead.
        assertLt(withHook - baseline, 560_000, "one hostile hook costs at most ~HOOK_GAS_STIPEND");
    }

    /// Cost grows linearly in the number of installed hooks. Governance (CONSTITUTIONAL_ROLE) is
    /// the only party that can install them, so this bounds a governance mistake rather than an
    /// attacker: 60 guzzling hooks is a full mainnet block.
    function test_GuzzlingHookCostScalesLinearlyWithHookCount() public {
        uint256 baseline = _land(0);
        for (uint256 i; i < 8; ++i) {
            snapshot.addHook(IMerkleSnapshotHook(address(new BurnAllGasHook())));
        }
        uint256 eight = _land(1);
        emit log_named_uint("submitProof gas, 8 guzzling hooks", eight);
        uint256 perHook = (eight - baseline) / 8;
        emit log_named_uint("per-hook cost", perHook);
        assertGt(perHook, 490_000, "each hook really does burn the stipend");
        emit log_named_uint("hooks to exceed a 30M block", 30_000_000 / perHook);
    }

    /// `try ... {} catch {}` with no return values and no catch parameter never copies returndata,
    /// so a hook cannot bomb the submitter.
    function test_ReturnDataBombHookDoesNotChargeTheSubmitter() public {
        uint256 baseline = _land(0);
        ReturnBombHook bomb = new ReturnBombHook();
        snapshot.addHook(IMerkleSnapshotHook(address(bomb)));
        uint256 withBomb = _land(1);
        emit log_named_uint("submitProof gas, returndata-bomb hook", withBomb);
        emit log_named_uint("delta", withBomb - baseline);
        // The callee pays its own memory expansion out of the stipend; the caller copies nothing.
        assertLt(withBomb - baseline, 560_000, "returndata is not copied into the caller");
    }
}
