// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title OzMerkle
/// @notice The minimal OpenZeppelin `StandardMerkleTree` root builder shared by the params
///         codecs and the signer module: sort the leaves ascending, then hash each parent as
///         the commutative `keccak256(abi.encode(min, max))`. Byte-identical to the guest
///         cores' tree builders (e.g. `pagerank-core`'s seed-set root).
/// @dev The golden-vector tests keep their own independent reimplementations on purpose — an
///      accidental change here must fail against them, never silently agree.
library OzMerkle {
    /// @notice Insertion sort (small n) of bytes32 ascending, in place.
    function sortInPlace(bytes32[] memory a) internal pure {
        for (uint256 i = 1; i < a.length; i++) {
            bytes32 key = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > key) {
                a[j] = a[j - 1];
                j--;
            }
            a[j] = key;
        }
    }

    /// @notice The StandardMerkleTree root over `leaves`. Sorts the array in place.
    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        if (n == 0) return bytes32(0);
        sortInPlace(leaves);
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
