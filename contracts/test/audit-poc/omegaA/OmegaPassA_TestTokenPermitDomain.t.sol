// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {TEST} from "src/tokens/TEST.sol";

/// @notice PASS A PoC.
///
/// `src/tokens/TEST.sol` constructs as `ERC20("TEST","TEST")` but `ERC20Permit("MyToken")`.
/// EIP-2612 fixes the EIP-712 domain `name` to the token's name, and every wallet builds the
/// permit domain from `name()`. Signatures produced that way will be rejected by this token.
contract OmegaPassA_TestTokenPermitDomain is Test {
    function test_PassA_PermitDomainNameDisagreesWithTokenName() public {
        TEST t = new TEST(address(this), address(this), address(this), address(this));
        (, string memory domainName,,,,,) = t.eip712Domain();
        assertEq(t.name(), "TEST");
        assertEq(domainName, "MyToken", "EIP-712 domain name is not the token name");
        assertTrue(
            keccak256(bytes(domainName)) != keccak256(bytes(t.name())),
            "EIP-2612 requires domain.name == name()"
        );
    }
}
