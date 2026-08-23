// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {SafeOwnerPolicy} from "src/factory/SafeOwnerPolicy.sol";
import {MockSafeOwner, NotASafe} from "../../helpers/MockSafeOwner.sol";

contract SafeOwnerPolicyHarness {
    function isSafe(address candidate) external view returns (bool) {
        return SafeOwnerPolicy.isSafe(candidate);
    }
}

contract SafeOwnerPolicyTest is Test {
    SafeOwnerPolicyHarness internal policy;

    function setUp() public {
        policy = new SafeOwnerPolicyHarness();
    }

    function test_AcceptsInitializedCoherentSafeShape() public {
        assertTrue(policy.isSafe(address(new MockSafeOwner(address(this), 1))));
    }

    function test_RejectsEoaUnrelatedContractAndInvalidSafeState() public {
        assertFalse(policy.isSafe(address(0xE0A)));
        assertFalse(policy.isSafe(address(new NotASafe())));
        assertFalse(policy.isSafe(address(new MockSafeOwner(address(0), 0))), "empty owners and zero threshold");
        assertFalse(policy.isSafe(address(new MockSafeOwner(address(this), 0))), "zero threshold");
        assertFalse(policy.isSafe(address(new MockSafeOwner(address(this), 2))), "threshold exceeds owner count");
    }
}
