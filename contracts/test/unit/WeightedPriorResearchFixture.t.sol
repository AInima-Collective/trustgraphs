// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";

/// @notice Cross-language research fixture for issue #34; no production contract imports this.
contract WeightedPriorResearchFixtureTest is Test {
    function test_NormalizationLeavesRootAndManifestMatchResearchFixture() public pure {
        address[3] memory accounts = [
            address(0x1111111111111111111111111111111111111111),
            address(0x2222222222222222222222222222222222222222),
            address(0x3333333333333333333333333333333333333333)
        ];
        uint256[3] memory weights =
            [uint256(740740740740740741), uint256(185185185185185185), uint256(74074074074074074)];
        assertEq(weights[0] + weights[1] + weights[2], 1e18);

        bytes32[3] memory leaves;
        for (uint256 i; i < 3; ++i) {
            leaves[i] = keccak256(abi.encode(accounts[i], weights[i]));
        }
        assertEq(leaves[0], 0xaddcc0abeeecb536f53079a4d48ae426a3083e1c9a9f62319b85ac631401983f);
        assertEq(leaves[1], 0x65bbc290da582760748a39220ba28959da2cf59a439c41ccc2eab852a7ff8d12);
        assertEq(leaves[2], 0x997f9107f9c8c4e0500e1093f3581d32952ee4b7fa4b33b4fee71ceba77116fa);

        bytes32 first = _hashPair(leaves[0], leaves[1]);
        assertEq(_hashPair(first, leaves[2]), 0x3bfa55c8c22dc55892da0439ba84748c4072b323d2ae036cb4088a60f46095cd);

        bytes memory manifest =
            hex"544757500001000000000000000a0000000311111111111111111111111111111111111111110a47a3c77282f68522222222222222222222222222222222222222220291e8f1dca0bda13333333333333333333333333333333333333333010729fa58404bda";
        assertEq(sha256(manifest), 0xcabfa154d35790a2decec957f63391a8ce6347a617ead7378ef2190fecc9e45b);
    }

    function _hashPair(bytes32 left, bytes32 right) private pure returns (bytes32) {
        return left < right ? keccak256(abi.encodePacked(left, right)) : keccak256(abi.encodePacked(right, left));
    }
}

