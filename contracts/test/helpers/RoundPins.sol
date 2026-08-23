// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Reads the state a funder must pin to call `distribute`.
/// @dev `distribute` has no unguarded form, so every test that funds a round has to name the root,
///      the payout denominator, the fee it agreed to and the recipient of that fee. Capture these
///      into a local BEFORE any `vm.prank`: they are external calls, and a single-shot prank would
///      otherwise be spent on the first read instead of on `distribute`.
library RoundPins {
    struct Pins {
        bytes32 root;
        uint256 totalValue;
        uint256 fee;
        address feeRecipient;
    }

    function read(MerkleFundDistributor d, uint256 amount) internal view returns (Pins memory p) {
        IMerkleSnapshot.MerkleState memory s = IMerkleSnapshot(d.merkleSnapshot()).getLatestState();
        p.root = s.root;
        p.totalValue = s.totalValue;
        p.fee = Math.mulDiv(amount, d.feePercentage(), d.FEE_RANGE());
        p.feeRecipient = d.feeRecipient();
    }
}
