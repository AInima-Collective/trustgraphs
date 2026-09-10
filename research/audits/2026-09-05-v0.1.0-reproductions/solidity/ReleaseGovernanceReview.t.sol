// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;
import {SignerSyncZkModuleTest} from "test/unit/SignerSyncZkModule.t.sol";
import {SignerSyncZkModule} from "src/zodiac/SignerSyncZkModule.sol";
import {GovernedTrustgraphsFactoryTest} from "test/unit/factory/GovernedTrustgraphsFactory.t.sol";
import {GovernedTrustgraphsFactory} from "src/factory/GovernedTrustgraphsFactory.sol";
import {GovernedFactoryBase} from "src/factory/GovernedFactoryBase.sol";
import {Safe} from "@safe-global/safe-smart-account/Safe.sol";
import {SafeProxyFactory} from "@safe-global/safe-smart-account/proxies/SafeProxyFactory.sol";

contract ReleaseSignerReview is SignerSyncZkModuleTest {
    function test_Review_NoopInitializesSingleton() public {
        vm.startPrank(address(safe));
        safe.removeOwner(B, C, 2);
        safe.removeOwner(A, B, 1);
        vm.stopPrank();
        assertEq(safe.getOwners().length, 1);
        assertFalse(module.hasAppliedCheckpoint());
        module.submitSignerProof(0, 0, _arr(A), 1, PROOF);
        assertTrue(module.hasAppliedCheckpoint(), "No-op unexpectedly switches guest to initialized policy");
        assertEq(safe.getOwners().length, 1);
        vm.expectRevert(abi.encodeWithSelector(SignerSyncZkModule.StaleCheckpoint.selector, uint256(0), uint256(0)));
        module.submitSignerProof(0, 0, _arr(A, B), 2, PROOF);
    }

    function test_Review_NewVoteInvalidatesPreparedProof() public {
        activitySource.push(keccak256("next-vote"), 3, uint64(block.number));
        vm.expectRevert(SignerSyncZkModule.ActivityCheckpointSuperseded.selector);
        module.submitSignerProof(0, 0, _arr(A, B, C), 2, PROOF);
    }
}

contract ReleaseCanonicalSafeReview is GovernedTrustgraphsFactoryTest {
    function test_Review_CanonicalProxySquatExhausts16Addresses() public {
        vm.createSelectFork("https://ethereum-sepolia-rpc.publicnode.com");
        setUp();
        safeFactory = SafeProxyFactory(0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2);
        safeSingleton = Safe(payable(0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552));
        governedFactory = new GovernedTrustgraphsFactory(
            factory,
            safeFactory,
            address(safeSingleton),
            authorityDeployer,
            signerSyncDeployer,
            govModuleDeployer,
            parentAuthorityDeployer,
            subnetworkRegistry,
            signerVerifier,
            SIGNER_VKEY
        );
        // Unsquatted positive control creates a real canonical Safe.
        vm.prank(creator);
        (, address goodSafe,,) = _createGoverned(_args("review-unsquatted"), _unpaidPolicy());
        assertTrue(goodSafe.codehash != governedFactory.SAFE_PROXY_RUNTIME_CODE_HASH(), "Canonical mismatch premise");
        string memory name = "review-squatted";
        address[] memory owners = new address[](1);
        owners[0] = address(governedFactory);
        bytes memory initializer = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            1,
            address(0),
            bytes(""),
            address(0),
            address(0),
            0,
            address(0)
        );
        uint256 baseNonce = uint256(keccak256(abi.encode(block.chainid, creator, name, bytes32(0))));
        for (uint256 bump; bump < 16; bump++) {
            uint256 nonce = bump == 0 ? baseNonce : uint256(keccak256(abi.encode(baseNonce, bump)));
            safeFactory.createProxyWithNonce(address(safeSingleton), initializer, nonce);
        }
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(GovernedFactoryBase.BootstrapSafeUnavailable.selector, baseNonce));
        _createGoverned(_args(name), _unpaidPolicy());
    }
}
