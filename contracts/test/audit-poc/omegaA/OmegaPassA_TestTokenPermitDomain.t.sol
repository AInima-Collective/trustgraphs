// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {TEST} from "src/tokens/TEST.sol";

/// @notice Regression for the TEST token's ERC-2612 domain and wallet-style permits.
contract OmegaPassA_TestTokenPermitDomain is Test {
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function test_PermitDomainNameMatchesTokenName() public {
        TEST t = new TEST(address(this), address(this), address(this), address(this));
        (, string memory domainName,,,,,) = t.eip712Domain();
        assertEq(t.name(), "TEST");
        assertEq(domainName, t.name(), "wallet and token must derive the same EIP-712 domain");
    }

    function test_WalletStylePermitUsingTokenNameSucceeds() public {
        TEST t = new TEST(address(this), address(this), address(this), address(this));
        uint256 ownerKey = 0xA11CE;
        address owner = vm.addr(ownerKey);
        address spender = makeAddr("spender");
        uint256 value = 123e18;
        uint256 deadline = block.timestamp + 1 days;
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, t.nonces(owner), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", t.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);

        t.permit(owner, spender, value, deadline, v, r, s);

        assertEq(t.allowance(owner, spender), value);
        assertEq(t.nonces(owner), 1);
    }
}
