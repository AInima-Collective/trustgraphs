// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ParamsCodec} from "src/params/ParamsCodec.sol";

/// @title AuditEncodingParity — AUDIT PoC (pre-testnet review, agent 2)
/// @notice Solidity side of the cross-language check for the encodings that NO golden vector
///         currently exercises: the non-empty `domainSetHash` branch, a `paramsHash` with
///         `minWeightFp` / `envelope0DomainSeparators` / `lane2MaxHeadAge` all non-default, an
///         anchor leaf with `envelopeKind != 0`, and a MULTI-entry `skippedDigest`.
///         Expected values are produced by
///         `cargo test -p pagerank-core --test audit_poc_encoding`.
contract AuditEncodingParityTest is Test {
    using stdJson for string;

    string internal json;

    function setUp() public {
        json = vm.readFile("contracts/test/audit-poc/audit-vectors.json");
    }

    function _params() internal pure returns (ParamsCodec.Params memory p) {
        uint256 s = 1e18;
        address[] memory seeds = new address[](2);
        seeds[0] = address(uint160(uint256(0x000101010101010101010101010101010101010101)));
        seeds[1] = address(uint160(uint256(0x000303030303030303030303030303030303030303)));
        bytes32[] memory seps = new bytes32[](2);
        seps[0] = bytes32(uint256(0xD1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1));
        seps[1] = bytes32(uint256(0xD2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2));
        p = ParamsCodec.Params({
            dampingFp: (s * 85) / 100,
            toleranceFp: s / 1_000_000,
            maxIterations: 100,
            minWeightFp: s / 4,
            maxWeightFp: s * 100,
            trustShareFp: s,
            trustDecayFp: (s * 80) / 100,
            trustedSeeds: seeds,
            totalPool: 10 ** 24,
            precisionScale: s,
            schemaUid: bytes32(uint256(0xABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABAB)),
            weightFieldIndex: 1,
            envelope0DomainSeparators: seps,
            lane2MaxHeadAge: 86_400,
            accumulator: address(uint160(uint256(0x00acacacacacacacacacacacacacacacacacacacac))),
            chainId: 31337
        });
    }

    /// The concat branch of `domainSetHash` (0 in every golden vector).
    function test_domainSetHash_nonEmpty_matchesRust() public view {
        bytes32[] memory seps = new bytes32[](2);
        seps[0] = bytes32(uint256(0xD1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1D1));
        seps[1] = bytes32(uint256(0xD2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2D2));
        assertEq(ParamsCodec.domainSetHash(seps), json.readBytes32(".domainSetHash"), "domainSetHash");
    }

    /// paramsHash with the three unpinned fields non-default.
    function test_paramsHash_unpinnedFields_matchRust() public view {
        assertEq(ParamsCodec.seedSetRoot(_params().trustedSeeds), json.readBytes32(".seedSetRoot"), "seedSetRoot");
        assertEq(ParamsCodec.hash(_params()), json.readBytes32(".paramsHash"), "paramsHash");
    }

    /// AnchorRegistry.anchor's leaf formula with envelopeKind = 1 (golden pins only kind 0).
    function test_anchorLeaf_envelopeKind1_matchesRust() public view {
        bytes32 leaf = keccak256(
            abi.encode(
                bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111)),
                uint8(1),
                bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222)),
                uint64(5),
                bytes32(uint256(0x3333333333333333333333333333333333333333333333333333333333333333)),
                uint256(1234)
            )
        );
        assertEq(leaf, json.readBytes32(".anchorLeafKind1"), "anchor leaf kind 1");
    }

    /// A two-entry skippedDigest (golden pins one entry only).
    function test_skippedDigest_twoEntries_matchesRust() public view {
        bytes32 l0 = keccak256(
            abi.encode(
                bytes32(uint256(0x4444444444444444444444444444444444444444444444444444444444444444)),
                uint8(1),
                uint64(7)
            )
        );
        bytes32 l1 = keccak256(
            abi.encode(
                bytes32(uint256(0x5555555555555555555555555555555555555555555555555555555555555555)),
                uint8(2),
                uint64(9)
            )
        );
        assertEq(l0, json.readBytes32(".skipLeaf0"), "skip leaf 0");
        assertEq(l1, json.readBytes32(".skipLeaf1"), "skip leaf 1");
        bytes32 acc = keccak256(abi.encode(bytes32(0), l0));
        acc = keccak256(abi.encode(acc, l1));
        assertEq(acc, json.readBytes32(".skippedDigest2"), "skippedDigest (2 entries)");
    }
}
