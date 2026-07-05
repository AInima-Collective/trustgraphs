// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title ParamsCodec
/// @notice On-chain encoder for the governance-pinned PageRank `paramsHash`, byte-identical to
///         `pagerank-core::encode::params_hash` (Rust) and `frontend/lib/pagerank` (TS). The three
///         encodings are locked together by `test/unit/GoldenVectors.t.sol`, which asserts this
///         library reproduces the golden vector exported from `pagerank-core`.
/// @dev    `paramsHash` is `keccak256(abi.encode(...13 static fields...))`. Because every field is a
///         static ABI type, `abi.encode` is just the concatenation of 32-byte words — the same bytes
///         the Rust guest hand-rolls. Field order/types are FROZEN; changing them requires updating
///         the golden vectors and the Rust/TS ports in lockstep.
library ParamsCodec {
    /// @notice The governance-pinned PageRank parameters (mirror of `pagerank_core::Params`).
    /// @dev `trustedSeeds` is the raw (unsorted) seed set; `seedSetRoot` sorts internally, so the
    ///      root depends only on the set, not the input order.
    struct Params {
        uint256 dampingFp;
        uint256 toleranceFp;
        uint32 maxIterations;
        uint256 minWeightFp;
        uint256 maxWeightFp;
        uint256 trustMultiplierFp;
        uint256 trustShareFp;
        uint256 trustDecayFp;
        address[] trustedSeeds;
        uint256 totalPool;
        uint256 precisionScale;
        bytes32 schemaUid;
        uint32 weightFieldIndex;
    }

    /// @notice The 13-field `paramsHash`. Field order + types are frozen against `params_hash` in
    ///         `pagerank-core` (slot 9 is the `seedSetRoot` over the sorted seeds).
    function hash(Params memory p) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                p.dampingFp,
                p.toleranceFp,
                p.maxIterations,
                p.minWeightFp,
                p.maxWeightFp,
                p.trustMultiplierFp,
                p.trustShareFp,
                p.trustDecayFp,
                seedSetRoot(p.trustedSeeds),
                p.totalPool,
                p.precisionScale,
                p.schemaUid,
                p.weightFieldIndex
            )
        );
    }

    /// @notice `seedSetRoot`: an OpenZeppelin StandardMerkleTree (sorted leaves, commutative parent
    ///         hashing) over `leaf = keccak256(abi.encode(address))`. Matches `merkle::seed_set_root`.
    function seedSetRoot(address[] memory seeds) internal pure returns (bytes32) {
        bytes32[] memory leaves = new bytes32[](seeds.length);
        for (uint256 i = 0; i < seeds.length; i++) {
            leaves[i] = keccak256(abi.encode(seeds[i]));
        }
        return _ozRoot(leaves);
    }

    /// @dev Minimal OpenZeppelin StandardMerkleTree root: sort leaves, then hash each parent as the
    ///      commutative `keccak256(abi.encode(min, max))`. Identical to the guest's tree builder.
    function _ozRoot(bytes32[] memory leaves) private pure returns (bytes32) {
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
