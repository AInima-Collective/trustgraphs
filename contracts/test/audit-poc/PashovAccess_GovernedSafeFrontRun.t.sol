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
import {TrustgraphsFactory} from "src/factory/TrustgraphsFactory.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {TrustgraphsFactoryBase} from "test/unit/factory/TrustgraphsFactoryBase.sol";

contract PashovAccessBootstrapSignerVerifier is IZkVerifier {
    bytes32 public constant programVKey = keccak256("pashov-access-bootstrap-signer");

    function verify(bytes calldata, bytes32) external pure {}
}

/// @title PashovAccess_GovernedSafeFrontRun
/// @notice Regression coverage for governed bootstrap Safe adoption, hostile near-match rejection,
///         and the bounded nonce-bump exhaustion path.
contract PashovAccess_GovernedSafeFrontRunTest is TrustgraphsFactoryBase {
    GovernedTrustgraphsFactory internal governedFactory;
    Safe internal safeSingleton;
    SafeProxyFactory internal safeFactory;

    address internal creator = address(0xA11CE);
    address internal attacker = address(0xBADBAD);

    function setUp() public override {
        super.setUp();
        safeSingleton = new Safe();
        safeFactory = new SafeProxyFactory();
        PashovAccessBootstrapSignerVerifier signerVerifier = new PashovAccessBootstrapSignerVerifier();
        governedFactory = new GovernedTrustgraphsFactory(
            factory,
            safeFactory,
            address(safeSingleton),
            new GovernedAuthorityDeployer(),
            new SignerSyncModuleDeployer(),
            new MerkleGovModuleDeployer(),
            new ParentAuthorityModuleDeployer(),
            new SubnetworkRegistry(registry, registryAdmin),
            signerVerifier,
            signerVerifier.programVKey()
        );
    }

    function _unpaidPolicy() internal pure returns (GovernedFactoryBase.InitialPolicy memory) {
        return GovernedFactoryBase.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0});
    }

    function _noSigner() internal pure returns (GovernedFactoryBase.SignerSyncConfig memory) {
        return GovernedFactoryBase.SignerSyncConfig({enabled: false, topN: 0, minThreshold: 0, targetThresholdBps: 0});
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
    function test_AttackerFrontRunsTheBootstrapSafeAndWrapperAdoptsIt() public {
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

        // The squatted Safe is the wrapper's exact pristine bootstrap Safe, so it is safe to adopt.
        assertTrue(Safe(payable(squatted)).isOwner(address(governedFactory)), "wrapper is the sole owner");

        TrustgraphsFactory.CreateArgs memory args = _args(name);
        args.salt = salt;

        vm.prank(creator);
        (, address adopted,,) = governedFactory.createGovernedInstance(args, _unpaidPolicy(), _noSigner());
        assertEq(adopted, squatted, "the exact bootstrap Safe must be adopted");
        assertTrue(Safe(payable(adopted)).isOwner(creator), "creation must graduate the adopted Safe");
        assertFalse(Safe(payable(adopted)).isOwner(address(governedFactory)), "wrapper must graduate out");
    }

    /// @notice Every retry with a fresh salt is equally griefable, because the attacker reads the
    ///         new (name, salt) out of the pending transaction and re-runs the same one-call block.
    function test_EveryFrontRunSaltIsAdopted() public {
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
            (, address safe,,) = governedFactory.createGovernedInstance(args, _unpaidPolicy(), _noSigner());
            assertTrue(Safe(payable(safe)).isOwner(creator));
        }
    }

    function test_NearMatchOnWrongSingletonIsNotAdopted() public {
        string memory name = "member-owned";
        bytes32 salt = bytes32(uint256(99));
        vm.prank(attacker);
        address hostile = address(
            safeFactory.createProxyWithNonce(
                address(safeSingleton), _bootstrapInitializer(), _bootstrapNonce(creator, name, salt)
            )
        );
        Safe otherSingleton = new Safe();
        vm.store(hostile, bytes32(0), bytes32(uint256(uint160(address(otherSingleton)))));

        TrustgraphsFactory.CreateArgs memory args = _args(name);
        args.salt = salt;
        vm.prank(creator);
        (, address safe,,) = governedFactory.createGovernedInstance(args, _unpaidPolicy(), _noSigner());

        assertTrue(safe != hostile, "a wrong-singleton near-match must not be adopted");
        assertTrue(Safe(payable(safe)).isOwner(creator), "the bumped Safe must graduate normally");
    }

    function test_BumpSearchIsBoundedWhenEveryCandidateIsHostile() public {
        string memory name = "bounded-search";
        bytes32 salt = bytes32(uint256(100));
        uint256 baseNonce = _bootstrapNonce(creator, name, salt);
        bytes memory initializer = _bootstrapInitializer();
        uint256 attempts = governedFactory.MAX_BOOTSTRAP_SAFE_ATTEMPTS();

        for (uint256 bump; bump < attempts; ++bump) {
            uint256 nonce = bump == 0 ? baseNonce : uint256(keccak256(abi.encode(baseNonce, bump)));
            address hostile = address(safeFactory.createProxyWithNonce(address(safeSingleton), initializer, nonce));
            // Safe 1.3.0's threshold is slot 4. A threshold of two with one owner is deliberately
            // hostile state that the adoption predicate must reject.
            vm.store(hostile, bytes32(uint256(4)), bytes32(uint256(2)));
        }

        TrustgraphsFactory.CreateArgs memory args = _args(name);
        args.salt = salt;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(GovernedFactoryBase.BootstrapSafeUnavailable.selector, baseNonce));
        governedFactory.createGovernedInstance(args, _unpaidPolicy(), _noSigner());
    }

    /// @dev CREATE2 address of the Safe proxy, computed the way `SafeProxyFactory` does.
    function _predict(string memory name, bytes32 salt) internal view returns (address) {
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
