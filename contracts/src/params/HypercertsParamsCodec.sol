// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {OzMerkle} from "../merkle/OzMerkle.sol";

/// @title HypercertsParamsCodec
/// @notice On-chain encoder for the hypercerts program's governance-pinned `paramsHash`,
///         byte-identical to `hypercerts_core::compute::params_hash` (Rust), the SP1 guest, and
///         `packages/frontend/lib/hypercerts` (TS). The four encodings are locked together by
///         `contracts/test/unit/golden/HypercertsGoldenVectors.t.sol`, which asserts this library reproduces
///         the golden vector exported from `hypercerts-core`.
/// @dev    `paramsHash` is `keccak256(abi.encode(...17 static fields...))`. Because every field is a
///         static ABI type, `abi.encode` is just the concatenation of 32-byte words — the same bytes
///         the Rust guest hand-rolls. Slot 9 is `seedSetRoot`, the OZ StandardMerkleTree over the
///         SORTED seed nodeIds (leaf = `keccak256(nodeId)`, one hash over the 32-byte id). Field
///         order/types are FROZEN; changing them requires regenerating the golden vectors and the
///         Rust/TS ports in lockstep.
library HypercertsParamsCodec {
    uint256 internal constant PARAMS_SCHEMA_VERSION = 3;

    /// @notice The governance-pinned hypercerts parameters (mirror of `hypercerts_core::Params`).
    /// @dev `trustedSeedDids` is the raw seed DID set; `seedSetRoot` derives nodeIds and sorts
    ///      internally, so the root depends only on the set, not the input order.
    struct Params {
        uint256 dampingFp;
        uint256 toleranceFp;
        uint32 maxIterations;
        uint256 trustShareFp;
        uint256 trustDecayFp;
        uint256 precisionScale;
        uint256 totalPool;
        string[] trustedSeedDids;
        uint256 wFollowFp;
        uint256 wBadgeFp;
        uint256 wEvalFp;
        uint256 wAttribFp;
        uint256 ackBoostFp;
        uint256 unackedAttribFp;
        uint256 pdsAttestedWeightFp;
        uint64 lane2MaxHeadAge;
    }

    /// @notice The 17-field `paramsHash`. Field order + types are frozen against `params_hash` in
    ///         `hypercerts-core` (slot 9 is the `seedSetRoot` over the sorted seed nodeIds).
    function hash(Params memory p) internal pure returns (bytes32) {
        // All 17 fields are static ABI types, so `abi.encode(all)` is just the concatenation of
        // their 32-byte words. Encode in two chunks (avoids stack-too-deep) and concat: the bytes
        // are byte-identical to a single 17-arg `abi.encode`, and to the Rust hand-rolled words.
        bytes memory head = abi.encode(
            PARAMS_SCHEMA_VERSION,
            p.dampingFp,
            p.toleranceFp,
            p.maxIterations,
            p.trustShareFp,
            p.trustDecayFp,
            p.precisionScale,
            p.totalPool,
            seedSetRoot(p.trustedSeedDids)
        );
        bytes memory tail = abi.encode(
            p.wFollowFp,
            p.wBadgeFp,
            p.wEvalFp,
            p.wAttribFp,
            p.ackBoostFp,
            p.unackedAttribFp,
            p.pdsAttestedWeightFp,
            p.lane2MaxHeadAge
        );
        return keccak256(bytes.concat(head, tail));
    }

    /// @notice The nodeId of a DID: `keccak256(bytes(did))` (mirrors `semantics::did_node_id`).
    function didNodeId(string memory did) internal pure returns (bytes32) {
        return keccak256(bytes(did));
    }

    /// @notice `seedSetRoot`: an OZ StandardMerkleTree (sorted leaves, commutative parent hashing)
    ///         over `leaf = keccak256(nodeId)` for each seed DID's nodeId. Matches
    ///         `hypercerts_core::compute::params_hash`'s seed-set root.
    function seedSetRoot(string[] memory dids) internal pure returns (bytes32) {
        bytes32[] memory ids = new bytes32[](dids.length);
        for (uint256 i = 0; i < dids.length; i++) {
            ids[i] = didNodeId(dids[i]);
        }
        // sort nodeIds ascending, then leaf = keccak256(nodeId).
        OzMerkle.sortInPlace(ids);
        bytes32[] memory leaves = new bytes32[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            leaves[i] = keccak256(abi.encodePacked(ids[i]));
        }
        return OzMerkle.root(leaves);
    }
}
