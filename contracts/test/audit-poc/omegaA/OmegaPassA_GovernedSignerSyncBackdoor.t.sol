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
import {SignerSyncZkModule} from "src/zodiac/SignerSyncZkModule.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {TrustgraphsFactoryBase} from "test/unit/factory/TrustgraphsFactoryBase.sol";

/// @notice A verifier the creator writes: it names any vkey it likes and accepts every proof.
contract CreatorControlledVerifier is IZkVerifier {
    bytes32 public immutable programVKey;

    constructor(bytes32 k) {
        programVKey = k;
    }

    function verify(bytes calldata, bytes32) external pure {}
}

/// @notice PASS A regression: a self-consistent creator verifier/vkey pair cannot enter the call;
///         every signer module receives the wrapper's constructor-validated immutable pair.
contract OmegaPassA_GovernedSignerSyncBackdoor is TrustgraphsFactoryBase {
    GovernedTrustgraphsFactory internal governedFactory;
    Safe internal safeSingleton;
    SafeProxyFactory internal safeFactory;
    CreatorControlledVerifier internal canonicalVerifier;

    address internal creator = address(0xA11CE);

    function setUp() public override {
        super.setUp();
        safeSingleton = new Safe();
        safeFactory = new SafeProxyFactory();
        canonicalVerifier = new CreatorControlledVerifier(keccak256("canonical-signer-guest"));
        governedFactory = new GovernedTrustgraphsFactory(
            factory,
            safeFactory,
            address(safeSingleton),
            new GovernedAuthorityDeployer(),
            new SignerSyncModuleDeployer(),
            new MerkleGovModuleDeployer(),
            new ParentAuthorityModuleDeployer(),
            new SubnetworkRegistry(registry, registryAdmin),
            canonicalVerifier,
            canonicalVerifier.programVKey()
        );
    }

    function test_PassA_CreatorCannotInstallItsOwnSignerVerifier() public {
        CreatorControlledVerifier fake = new CreatorControlledVerifier(keccak256("i-made-this-up"));

        TrustgraphsFactory.CreateArgs memory args = _args("backdoored");
        args.salt = bytes32(uint256(0xB4D));

        vm.prank(creator);
        (bytes32 instanceId, address safe,,) = governedFactory.createGovernedInstance(
            args,
            GovernedFactoryBase.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0}),
            GovernedFactoryBase.SignerSyncConfig({enabled: true, topN: 3, minThreshold: 2, targetThresholdBps: 5_000})
        );

        GovernedFactoryBase.Authority memory authority = governedFactory.authorityOf(instanceId);
        address module = authority.signerSyncModule;
        assertTrue(module != address(0), "module not installed");
        assertTrue(Safe(payable(safe)).isModuleEnabled(module), "canonical signer module is live on the Safe");
        assertEq(
            address(SignerSyncZkModule(module).zkVerifier()),
            address(canonicalVerifier),
            "wrapper must install its immutable verifier"
        );
        assertTrue(address(SignerSyncZkModule(module).zkVerifier()) != address(fake), "creator verifier was installed");

        // And it is armed: nothing about the module distinguishes it from a real signer-sync
        // module to anybody reading the discovery events.
        assertEq(SignerSyncZkModule(module).owner(), safe);
        assertFalse(SignerSyncZkModule(module).paused());
    }
}
