// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Structural validation for an address intended to own community funds.
/// @dev Safe proxies expose both methods through their singleton. Checking the returned ABI shape,
///      nonempty owner set, and coherent threshold rejects EOAs, uninitialized proxies, and
///      unrelated contracts before a distributor can be deployed under an unusable owner.
library SafeOwnerPolicy {
    bytes4 private constant GET_OWNERS_SELECTOR = bytes4(keccak256("getOwners()"));
    bytes4 private constant GET_THRESHOLD_SELECTOR = bytes4(keccak256("getThreshold()"));

    function isSafe(address candidate) internal view returns (bool) {
        if (candidate.code.length == 0) return false;

        (bool ok, bytes memory thresholdResult) = candidate.staticcall(abi.encodeWithSelector(GET_THRESHOLD_SELECTOR));
        if (!ok || thresholdResult.length != 32) return false;

        uint256 threshold;
        assembly ("memory-safe") {
            threshold := mload(add(thresholdResult, 0x20))
        }
        if (threshold == 0) return false;

        bytes memory ownersResult;
        (ok, ownersResult) = candidate.staticcall(abi.encodeWithSelector(GET_OWNERS_SELECTOR));
        if (!ok || ownersResult.length < 64) return false;

        uint256 offset;
        uint256 ownerCount;
        assembly ("memory-safe") {
            offset := mload(add(ownersResult, 0x20))
            ownerCount := mload(add(ownersResult, 0x40))
        }

        // `address[]` has one offset word, one length word, then one word per owner. Requiring the
        // exact canonical layout avoids accepting truncated, trailing, or adversarial returndata.
        if (offset != 32 || ownerCount == 0 || ownerCount > (ownersResult.length - 64) / 32) return false;
        if (ownersResult.length != 64 + ownerCount * 32 || threshold > ownerCount) return false;

        for (uint256 i = 0; i < ownerCount; i++) {
            uint256 encodedOwner;
            assembly ("memory-safe") {
                encodedOwner := mload(add(add(ownersResult, 0x60), mul(i, 0x20)))
            }
            if (encodedOwner == 0 || encodedOwner >> 160 != 0) return false;
        }
        return true;
    }
}
