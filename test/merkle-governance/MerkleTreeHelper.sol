// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title MerkleTreeHelper
 * @notice Simplified helper contract for generating merkle trees and proofs in tests
 * @dev Matches the leaf structure used by MerkleVote and MerkleFundDistributor
 */
contract MerkleTreeHelper {
    struct AccountData {
        address account;
        uint256 votingPower;
    }

    /**
     * @notice Generate a merkle leaf for an account
     * @dev Uses double keccak256 pattern for merkle tree construction
     */
    function generateLeaf(address account, uint256 votingPower) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, votingPower))));
    }

    /**
     * @notice Build a simple merkle tree for testing
     * @dev This is a simplified implementation for small test sets
     * @param accounts Array of account data
     * @return root The merkle root
     */
    function buildMerkleTree(AccountData[] memory accounts) public pure returns (bytes32 root, bytes32[] memory) {
        require(accounts.length > 0, "Empty accounts array");

        if (accounts.length == 1) {
            bytes32[] memory tree = new bytes32[](1);
            tree[0] = generateLeaf(accounts[0].account, accounts[0].votingPower);
            return (tree[0], tree);
        }

        // For simplicity, we'll just build a tree with a fixed structure for our 5 test accounts
        // This avoids the complexity of dynamic tree building
        if (accounts.length == 5) {
            bytes32[] memory leaves = new bytes32[](5);
            for (uint256 i = 0; i < 5; i++) {
                leaves[i] = generateLeaf(accounts[i].account, accounts[i].votingPower);
            }

            // Build tree manually for 5 leaves
            // Level 0: 5 leaves
            // Level 1: 3 nodes (pair 0-1, pair 2-3, leaf 4)
            // Level 2: 2 nodes (pair of level1[0-1], level1[2])
            // Level 3: root

            bytes32 node01 = _hashPair(leaves[0], leaves[1]);
            bytes32 node23 = _hashPair(leaves[2], leaves[3]);
            bytes32 node01_23 = _hashPair(node01, node23);
            root = _hashPair(node01_23, leaves[4]);

            bytes32[] memory tree = new bytes32[](9);
            tree[0] = leaves[0];
            tree[1] = leaves[1];
            tree[2] = leaves[2];
            tree[3] = leaves[3];
            tree[4] = leaves[4];
            tree[5] = node01;
            tree[6] = node23;
            tree[7] = node01_23;
            tree[8] = root;

            return (root, tree);
        }

        // For 2 accounts (used in the test)
        if (accounts.length == 2) {
            bytes32[] memory leaves = new bytes32[](2);
            for (uint256 i = 0; i < 2; i++) {
                leaves[i] = generateLeaf(accounts[i].account, accounts[i].votingPower);
            }

            root = _hashPair(leaves[0], leaves[1]);

            bytes32[] memory tree = new bytes32[](3);
            tree[0] = leaves[0];
            tree[1] = leaves[1];
            tree[2] = root;

            return (root, tree);
        }

        revert("Unsupported account count for testing");
    }

    /**
     * @notice Generate a merkle proof for a specific account
     * @dev Hardcoded for our test scenarios
     * @param accounts Array of all accounts in the tree
     * @param targetIndex Index of the account to generate proof for
     * @return proof The merkle proof
     */
    function generateProof(AccountData[] memory accounts, uint256 targetIndex)
        public
        pure
        returns (bytes32[] memory proof)
    {
        require(targetIndex < accounts.length, "Invalid target index");

        if (accounts.length == 1) {
            return new bytes32[](0);
        }

        // For 5 accounts - our main test case
        if (accounts.length == 5) {
            bytes32[] memory leaves = new bytes32[](5);
            for (uint256 i = 0; i < 5; i++) {
                leaves[i] = generateLeaf(accounts[i].account, accounts[i].votingPower);
            }

            bytes32 node01 = _hashPair(leaves[0], leaves[1]);
            bytes32 node23 = _hashPair(leaves[2], leaves[3]);
            bytes32 node01_23 = _hashPair(node01, node23);

            if (targetIndex == 0) {
                proof = new bytes32[](3);
                proof[0] = leaves[1]; // sibling at leaf level
                proof[1] = node23; // sibling at level 1
                proof[2] = leaves[4]; // sibling at level 2
                return proof;
            }
            if (targetIndex == 1) {
                proof = new bytes32[](3);
                proof[0] = leaves[0]; // sibling at leaf level
                proof[1] = node23; // sibling at level 1
                proof[2] = leaves[4]; // sibling at level 2
                return proof;
            }
            if (targetIndex == 2) {
                proof = new bytes32[](3);
                proof[0] = leaves[3]; // sibling at leaf level
                proof[1] = node01; // sibling at level 1
                proof[2] = leaves[4]; // sibling at level 2
                return proof;
            }
            if (targetIndex == 3) {
                proof = new bytes32[](3);
                proof[0] = leaves[2]; // sibling at leaf level
                proof[1] = node01; // sibling at level 1
                proof[2] = leaves[4]; // sibling at level 2
                return proof;
            }
            if (targetIndex == 4) {
                proof = new bytes32[](1);
                proof[0] = node01_23; // sibling at root level
                return proof;
            }
        }

        // For 2 accounts
        if (accounts.length == 2) {
            proof = new bytes32[](1);
            if (targetIndex == 0) {
                proof[0] = generateLeaf(accounts[1].account, accounts[1].votingPower);
            } else {
                proof[0] = generateLeaf(accounts[0].account, accounts[0].votingPower);
            }
            return proof;
        }

        revert("Unsupported configuration");
    }

    /**
     * @notice Verify a merkle proof
     * @param root The merkle root
     * @param account The account address
     * @param votingPower The voting power amount
     * @param proof The merkle proof
     * @return valid Whether the proof is valid
     */
    function verifyProof(bytes32 root, address account, uint256 votingPower, bytes32[] memory proof)
        public
        pure
        returns (bool valid)
    {
        bytes32 leaf = generateLeaf(account, votingPower);
        return MerkleProof.verify(proof, root, leaf);
    }

    /**
     * @notice Hash a pair of nodes
     * @dev Ensures consistent ordering
     */
    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
