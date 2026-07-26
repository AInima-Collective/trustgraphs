// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @title SignerGoldenVectors
/// @notice Cross-language lock (Risk R2) for the `signer` (signer-sync) program: independently
///         recompute in Solidity every frozen byte format that `pagerank-core` produces for the
///         `.signer` section of the golden feed and assert equality. If the guest's Rust encoding and
///         the on-chain Solidity encoding ever diverge, this test fails.
/// @dev    The `trust-graph` and `signer` programs share the same golden feed
///         (`test/golden/trust-graph.json`); the root-producer sections are asserted in
///         TrustGraphGoldenVectors.t.sol.
contract SignerGoldenVectorsTest is Test {
    using stdJson for string;

    string json;

    function setUp() public {
        json = vm.readFile("test/golden/trust-graph.json");
    }

    /// selectionParamsHash: keccak256(abi.encode(uint32 topN, uint32 minThreshold, uint32 targetBps)).
    function test_SelectionParamsHash() public view {
        bytes memory encoded = abi.encode(
            uint32(json.readUint(".signer.selection.topN")),
            uint32(json.readUint(".signer.selection.minThreshold")),
            uint32(json.readUint(".signer.selection.targetThresholdBps"))
        );
        assertEq(keccak256(encoded), json.readBytes32(".signer.selectionParamsHash"), "selectionParamsHash mismatch");
    }

    /// signerSetRoot: OZ standard tree over the selected owner set (leaf = keccak256(abi.encode(address))).
    function test_SignerSetRoot() public view {
        address[] memory signers = json.readAddressArray(".signer.signers");
        bytes32[] memory leaves = new bytes32[](signers.length);
        for (uint256 i = 0; i < signers.length; i++) {
            leaves[i] = keccak256(abi.encode(signers[i]));
        }
        assertEq(_ozRoot(leaves), json.readBytes32(".signer.signerSetRoot"), "signerSetRoot mismatch");
    }

    /// Signer journal: abi.encode(bytes32, uint64, bytes32, bytes32, bytes32, uint256) and its keccak.
    /// This is the EXACT tuple `SignerSyncZkModule.submitSignerProof` rebuilds and verifies against.
    function test_SignerJournalEncodingAndDigest() public view {
        bytes memory encoded = abi.encode(
            json.readBytes32(".signer.journal.acc"),
            uint64(json.readUint(".signer.journal.leafCount")),
            json.readBytes32(".signer.journal.paramsHash"),
            json.readBytes32(".signer.journal.selectionParamsHash"),
            json.readBytes32(".signer.journal.signerSetRoot"),
            json.readUint(".signer.journal.targetThreshold")
        );
        assertEq(encoded, json.readBytes(".signer.journal.encoded"), "signer journal encoding mismatch");
        assertEq(keccak256(encoded), json.readBytes32(".signer.journal.digest"), "signer journal digest mismatch");
    }

    /// Minimal OpenZeppelin StandardMerkleTree root (sorted leaves, commutative parent hashing).
    function _ozRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        if (n == 0) return bytes32(0);
        // insertion sort (small n)
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
