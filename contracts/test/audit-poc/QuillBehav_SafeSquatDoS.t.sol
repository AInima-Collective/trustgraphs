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

contract QuillBootstrapSignerVerifier is IZkVerifier {
    bytes32 public constant programVKey = keccak256("quill-bootstrap-signer");

    function verify(bytes calldata, bytes32) external pure {}
}

/// @notice Regression for the predictable bootstrap address: an exact permissionlessly deployed
///         Safe is adopted and graduated, so occupying it cannot brick governed creation.
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
        QuillBootstrapSignerVerifier signerVerifier = new QuillBootstrapSignerVerifier();
        governedFactory = new GovernedTrustgraphsFactory(
            factory,
            safeFactory,
            address(safeSingleton),
            new GovernedAuthorityDeployer(),
            new SignerSyncModuleDeployer(),
            new MerkleGovModuleDeployer(),
            signerVerifier,
            signerVerifier.programVKey()
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

    function _noSigner() internal pure returns (GovernedFactoryBase.SignerSyncConfig memory) {
        return
            GovernedFactoryBase.SignerSyncConfig({
                enabled: false, topN: 0, minThreshold: 0, targetThresholdBps: 0
            });
    }

    function test_PredeployedBootstrapSafeCannotBrickGovernedCreation() public {
        TrustgraphsFactory.CreateArgs memory args = _args("member-owned");
        args.salt = bytes32(uint256(7));

        // 1. Sanity: without interference the victim's creation succeeds. Record what it costs
        //    the squatter to reproduce, then roll back with a snapshot.
        uint256 snap = vm.snapshotState();
        vm.prank(victim);
        governedFactory.createGovernedInstance(
            args, GovernedFactoryBase.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0}), _noSigner()
        );
        vm.revertToState(snap);

        // 2. The squatter reproduces the wrapper's own derivation from public data only.
        uint256 nonce = uint256(keccak256(abi.encode(block.chainid, victim, args.name, args.salt)));
        bytes memory initializer = _bootstrapInitializer(address(governedFactory));

        vm.prank(squatter);
        address squatted = address(safeFactory.createProxyWithNonce(address(safeSingleton), initializer, nonce));
        assertTrue(squatted.code.length > 0, "squatter deployed the wrapper's bootstrap Safe");

        // 3. The victim adopts the exact pristine Safe and completes creation normally.
        vm.prank(victim);
        (, address safe,,) = governedFactory.createGovernedInstance(
            args, GovernedFactoryBase.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0}), _noSigner()
        );
        assertEq(safe, squatted, "the exact bootstrap Safe is reusable, not a collision");

        // 4. Atomic graduation still replaces the wrapper with the intended creator.
        address[] memory owners = GnosisSafe(payable(squatted)).getOwners();
        assertEq(owners.length, 1);
        assertEq(owners[0], victim, "adopted Safe must graduate to the intended creator");
    }
}
