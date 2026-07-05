//! OpenZeppelin Standard Merkle Tree, reproduced exactly so the frontend can use
//! `@openzeppelin/merkle-tree` and the on-chain `MerkleProof.verifyCalldata` (commutative /
//! sorted-pair hashing) verifies guest-produced proofs unchanged (PLAN.md §1.4).

use crate::encode::{word_addr, word_u256};
use alloy_primitives::{keccak256, Address, B256, U256};

/// The output-tree leaf: `keccak256(bytes.concat(keccak256(abi.encode(address account, uint256 value))))`.
/// Matches `MerkleSnapshot.sol:129`.
pub fn output_leaf(account: Address, value: U256) -> B256 {
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(&word_addr(account));
    buf[32..].copy_from_slice(&word_u256(value));
    let inner = keccak256(&buf);
    keccak256(inner.as_slice())
}

/// Commutative parent hash: `keccak256(sort(a, b))`.
fn hash_pair(a: B256, b: B256) -> B256 {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(lo.as_slice());
    buf[32..].copy_from_slice(hi.as_slice());
    keccak256(&buf)
}

/// Build the OZ StandardMerkleTree root from a set of leaf hashes.
///
/// Algorithm (identical to `@openzeppelin/merkle-tree`'s `makeMerkleTree`):
/// sort leaves ascending; place them at the tail of a `2n-1` array in reverse order; each internal
/// node `i` = `hashPair(tree[2i+1], tree[2i+2])`. Root = `tree[0]`. Empty ⇒ `bytes32(0)`;
/// single leaf ⇒ that leaf.
pub fn merkle_root(mut leaves: Vec<B256>) -> B256 {
    if leaves.is_empty() {
        return B256::ZERO;
    }
    leaves.sort();
    let n = leaves.len();
    if n == 1 {
        return leaves[0];
    }
    let size = 2 * n - 1;
    let mut tree = vec![B256::ZERO; size];
    for (i, leaf) in leaves.iter().enumerate() {
        tree[size - 1 - i] = *leaf;
    }
    // Internal nodes are indices [0, n-2]; fill bottom-up.
    for i in (0..n - 1).rev() {
        tree[i] = hash_pair(tree[2 * i + 1], tree[2 * i + 2]);
    }
    tree[0]
}

/// Build the full tree array (for proof generation by the host/frontend).
pub fn build_tree(mut leaves: Vec<B256>) -> Vec<B256> {
    if leaves.is_empty() {
        return vec![];
    }
    leaves.sort();
    let n = leaves.len();
    if n == 1 {
        return leaves;
    }
    let size = 2 * n - 1;
    let mut tree = vec![B256::ZERO; size];
    for (i, leaf) in leaves.iter().enumerate() {
        tree[size - 1 - i] = *leaf;
    }
    for i in (0..n - 1).rev() {
        tree[i] = hash_pair(tree[2 * i + 1], tree[2 * i + 2]);
    }
    tree
}

/// A Merkle proof for a leaf at sorted position, as sibling hashes leaf→root (OZ format).
pub fn proof_for(tree: &[B256], leaf: B256) -> Option<Vec<B256>> {
    if tree.is_empty() {
        return None;
    }
    let n = (tree.len() + 1) / 2;
    // Leaves occupy [n-1, 2n-1). Find our leaf index.
    let mut idx = None;
    for i in (n - 1)..tree.len() {
        if tree[i] == leaf {
            idx = Some(i);
            break;
        }
    }
    let mut i = idx?;
    let mut proof = Vec::new();
    while i > 0 {
        let sibling = if i % 2 == 1 { i + 1 } else { i - 1 };
        if sibling < tree.len() {
            proof.push(tree[sibling]);
        }
        i = (i - 1) / 2;
    }
    Some(proof)
}

/// The `seedSetRoot` folded into `paramsHash`: an OZ StandardMerkleTree over the sorted seed set,
/// with leaf = `keccak256(abi.encode(address seed))`. Empty set ⇒ `bytes32(0)`.
pub fn seed_set_root(sorted_seeds: &[Address]) -> B256 {
    if sorted_seeds.is_empty() {
        return B256::ZERO;
    }
    let leaves: Vec<B256> = sorted_seeds.iter().map(|a| keccak256(word_addr(*a))).collect();
    merkle_root(leaves)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn single_leaf_root_is_leaf() {
        let a = Address::from([0x11; 20]);
        let leaf = output_leaf(a, U256::from(100));
        assert_eq!(merkle_root(vec![leaf]), leaf);
    }

    #[test]
    fn empty_root_is_zero() {
        assert_eq!(merkle_root(vec![]), B256::ZERO);
        assert_eq!(seed_set_root(&[]), B256::ZERO);
    }

    #[test]
    fn proof_verifies_against_root() {
        let accts: Vec<Address> = (1u8..=5)
            .map(|i| Address::from_str(&format!("0x{:040x}", i)).unwrap())
            .collect();
        let leaves: Vec<B256> =
            accts.iter().map(|a| output_leaf(*a, U256::from(10u64))).collect();
        let root = merkle_root(leaves.clone());
        let tree = build_tree(leaves.clone());
        for leaf in &leaves {
            let proof = proof_for(&tree, *leaf).unwrap();
            // Reproduce MerkleProof.verify: fold with commutative hashing.
            let mut computed = *leaf;
            for sib in proof {
                computed = hash_pair(computed, sib);
            }
            assert_eq!(computed, root);
        }
    }
}
