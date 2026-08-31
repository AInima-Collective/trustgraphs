// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

import {GovernedTrustgraphsFactory} from "src/factory/GovernedTrustgraphsFactory.sol";
import {GovernedFactoryBase} from "src/factory/GovernedFactoryBase.sol";
import {
    GovernedAuthorityDeployer,
    MerkleGovModuleDeployer,
    SignerSyncModuleDeployer
} from "src/factory/InstanceDeployers.sol";
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {TrustgraphsFactoryBase} from "test/unit/factory/TrustgraphsFactoryBase.sol";

contract PashovTraceBootstrapSignerVerifier is IZkVerifier {
    bytes32 public constant programVKey = keccak256("pashov-trace-bootstrap-signer");

    function verify(bytes calldata, bytes32) external pure {}
}

/// @notice Regression trace: an exact mempool-front-run bootstrap Safe is validated, adopted, and
///         atomically graduated instead of entering Gnosis Safe's gas-burning CREATE2 collision.
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
        PashovTraceBootstrapSignerVerifier signerVerifier = new PashovTraceBootstrapSignerVerifier();
        governedFactory = new GovernedTrustgraphsFactory(
            factory,
            safeFactory,
            address(safeSingleton),
            authorityDeployer,
            signerSyncDeployer,
            govModuleDeployer,
            signerVerifier,
            signerVerifier.programVKey()
        );
    }

    function _noPolicy() internal pure returns (GovernedFactoryBase.InitialPolicy memory) {
        return GovernedFactoryBase.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0});
    }

    function _noSigner() internal pure returns (GovernedFactoryBase.SignerSyncConfig memory) {
        return
            GovernedFactoryBase.SignerSyncConfig({
                enabled: false, topN: 0, minThreshold: 0, targetThresholdBps: 0
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

    function test_ExactFrontRunSafeIsAdoptedWithoutRetry() public {
        TrustgraphsFactory.CreateArgs memory args = _args("acme-dao");
        args.salt = bytes32(uint256(1));

        // The griefer reads the victim's pending calldata and recomputes the bootstrap nonce.
        uint256 nonce = uint256(keccak256(abi.encode(block.chainid, creator, args.name, args.salt)));

        vm.prank(griefer);
        safeFactory.createProxyWithNonce(address(safeSingleton), _bootstrapInitializer(), nonce);

        // The victim precomputes the occupied address, validates the pristine Safe, and adopts it.
        vm.prank(creator);
        (, address safe,,) = governedFactory.createGovernedInstance(args, _noPolicy(), _noSigner());
        assertTrue(GnosisSafe(payable(safe)).isOwner(creator));

        // A second independently front-run tuple is adopted in the same way.
        args.salt = bytes32(uint256(2));
        uint256 nonce2 = uint256(keccak256(abi.encode(block.chainid, creator, args.name, args.salt)));
        vm.prank(griefer);
        safeFactory.createProxyWithNonce(address(safeSingleton), _bootstrapInitializer(), nonce2);
        vm.prank(creator);
        (, safe,,) = governedFactory.createGovernedInstance(args, _noPolicy(), _noSigner());
        assertTrue(GnosisSafe(payable(safe)).isOwner(creator));
    }
}
