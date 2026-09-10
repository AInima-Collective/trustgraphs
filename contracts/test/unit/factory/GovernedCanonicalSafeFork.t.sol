// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Safe} from "@safe-global/safe-smart-account/Safe.sol";
import {SafeProxyFactory} from "@safe-global/safe-smart-account/proxies/SafeProxyFactory.sol";
import {GovernedTrustgraphsFactory} from "src/factory/GovernedTrustgraphsFactory.sol";
import {GovernedFactoryBase} from "src/factory/GovernedFactoryBase.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    ParentAuthorityModuleDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";
import {SubnetworkRegistry} from "src/registry/SubnetworkRegistry.sol";
import {SafeExecutionGuard} from "src/zodiac/SafeExecutionGuard.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {TrustgraphsFactoryBase} from "test/unit/factory/TrustgraphsFactoryBase.sol";

contract CanonicalForkSignerVerifier is IZkVerifier {
    bytes32 public constant programVKey = keccak256("fork fixture signer");

    function verify(bytes calldata, bytes32) external pure {
        revert("unused in this test");
    }
}

/// @notice Exact deployed Safe compatibility; enable with SAFE_FORK_RPC_URL set to a Sepolia RPC.
/// @dev Protocol fixtures are local; proxy creation and Safe execution use the canonical chain code.
contract GovernedCanonicalSafeForkTest is TrustgraphsFactoryBase {
    function test_CanonicalSafeAdoptsAllPredeployedBootstrapCandidates() public {
        string memory rpc = vm.envOr("SAFE_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 11155111, "SAFE_FORK_RPC_URL must be Sepolia");
        super.setUp();
        SafeProxyFactory canonicalFactory = SafeProxyFactory(0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2);
        address canonicalSingleton = 0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552;
        CanonicalForkSignerVerifier signerVerifier = new CanonicalForkSignerVerifier();
        GovernedTrustgraphsFactory governed = new GovernedTrustgraphsFactory(
            factory,
            canonicalFactory,
            canonicalSingleton,
            new GovernedAuthorityDeployer(),
            new SignerSyncModuleDeployer(),
            new MerkleGovModuleDeployer(),
            new ParentAuthorityModuleDeployer(),
            new SubnetworkRegistry(registry, registryAdmin),
            signerVerifier,
            signerVerifier.programVKey()
        );
        address creator = address(0xA11CE);
        GovernedFactoryBase.InitialPolicy memory policy = GovernedFactoryBase.InitialPolicy(0, 0);
        GovernedFactoryBase.SignerSyncConfig memory signer = GovernedFactoryBase.SignerSyncConfig(false, 0, 0, 0);
        vm.prank(creator);
        (, address unsquatted,,) = governed.createGovernedInstance(_args("canonical unsquatted"), policy, signer);
        assertEq(unsquatted.codehash, governed.SAFE_PROXY_RUNTIME_CODE_HASH());
        assertEq(unsquatted.codehash, 0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000);

        address[] memory owners = new address[](1);
        owners[0] = address(governed);
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
        string memory name = "canonical predeployed";
        uint256 baseNonce = uint256(keccak256(abi.encode(block.chainid, creator, name, bytes32(0))));
        address first;
        for (uint256 bump; bump < governed.MAX_BOOTSTRAP_SAFE_ATTEMPTS(); ++bump) {
            uint256 nonce = bump == 0 ? baseNonce : uint256(keccak256(abi.encode(baseNonce, bump)));
            address candidate = address(canonicalFactory.createProxyWithNonce(canonicalSingleton, initializer, nonce));
            if (bump == 0) first = candidate;
        }
        vm.prank(creator);
        (bytes32 instanceId, address adopted,,) = governed.createGovernedInstance(_args(name), policy, signer);
        assertEq(adopted, first, "the exact first canonical bootstrap proxy must be adopted");
        assertTrue(Safe(payable(adopted)).isOwner(creator));
        assertFalse(Safe(payable(adopted)).isOwner(address(governed)));
        GovernedFactoryBase.Authority memory authority = governed.authorityOf(instanceId);
        assertTrue(SafeExecutionGuard(authority.executionGuard).isSealed());
    }
}
