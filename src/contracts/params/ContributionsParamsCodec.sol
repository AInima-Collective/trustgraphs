// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title ContributionsParamsCodec
/// @notice On-chain encoder for the contributions program's governance-pinned `paramsHash`,
///         byte-identical to `contributions_core::params::params_hash` (Rust), the SP1 guest, and
///         `frontend/lib/contributions` (TS). The four encodings are locked together by
///         `test/unit/golden/ContributionsGoldenVectors.t.sol`, which asserts this library
///         reproduces the golden vector exported from `contributions-core`.
/// @dev    `paramsHash` is `keccak256(abi.encode(...21 static fields...))` — see
///         `docs/build/contributions/interfaces.md` §3. Because every field is a static ABI type,
///         `abi.encode` is just the concatenation of 32-byte words — the same bytes the Rust
///         guest hand-rolls. Slots 1–11 are the stage-1 reputation params mirrored from the trust
///         program (slot 9 is `seedSetRoot` over the sorted seed addresses); slots 12–21 are the
///         round params. Field order/types are FROZEN; changing them requires regenerating the
///         golden vectors and the Rust/TS ports in lockstep.
library ContributionsParamsCodec {
    /// @notice The governance-pinned contributions parameters (mirror of
    ///         `contributions_core::Params`).
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
        uint256 precisionScale;
        uint32 weightFieldIndex;
        uint64 roundStart;
        uint64 roundEnd;
        uint256 unacceptedMultFp;
        uint256 collaboratorMultFp;
        uint256 minRaterRepFp;
        uint32 evaluatorCarveoutBps;
        uint256 totalPool;
        bytes32 claimSchemaUid;
        bytes32 responseSchemaUid;
        bytes32 valuationSchemaUid;
    }

    /// @notice The 21-field `paramsHash` (INTERFACES.md §3). Encoded in two chunks (avoids
    ///         stack-too-deep); the bytes are byte-identical to a single 21-arg `abi.encode`.
    function hash(Params memory p) internal pure returns (bytes32) {
        bytes memory head = abi.encode(
            p.dampingFp,
            p.toleranceFp,
            p.maxIterations,
            p.minWeightFp,
            p.maxWeightFp,
            p.trustMultiplierFp,
            p.trustShareFp,
            p.trustDecayFp,
            seedSetRoot(p.trustedSeeds),
            p.precisionScale,
            p.weightFieldIndex
        );
        bytes memory tail = abi.encode(
            p.roundStart,
            p.roundEnd,
            p.unacceptedMultFp,
            p.collaboratorMultFp,
            p.minRaterRepFp,
            p.evaluatorCarveoutBps,
            p.totalPool,
            p.claimSchemaUid,
            p.responseSchemaUid,
            p.valuationSchemaUid
        );
        return keccak256(bytes.concat(head, tail));
    }

    /// @notice `seedSetRoot`: an OZ StandardMerkleTree (sorted leaves, commutative parent
    ///         hashing) over `leaf = keccak256(abi.encode(address))`. Matches
    ///         `zk_core::merkle::seed_set_root` — identical to the trust program's builder.
    function seedSetRoot(address[] memory seeds) internal pure returns (bytes32) {
        bytes32[] memory leaves = new bytes32[](seeds.length);
        for (uint256 i = 0; i < seeds.length; i++) {
            leaves[i] = keccak256(abi.encode(seeds[i]));
        }
        return _ozRoot(leaves);
    }

    /// @dev Minimal OpenZeppelin StandardMerkleTree root: sort leaves, then hash each parent as
    ///      the commutative `keccak256(abi.encode(min, max))`. Identical to the guest's builder.
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
