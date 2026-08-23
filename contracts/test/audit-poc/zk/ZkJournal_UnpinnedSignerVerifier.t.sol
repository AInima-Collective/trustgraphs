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
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {SignerSyncZkModule} from "src/zodiac/SignerSyncZkModule.sol";
import {MerkleGovModule} from "src/zodiac/MerkleGovModule.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {TrustgraphsFactoryBase} from "test/unit/factory/TrustgraphsFactoryBase.sol";

/// A verifier that satisfies every check `SignerSyncModuleDeployer` performs — it is a contract,
/// it exposes `programVKey()`, and that value equals the `programVKey` passed alongside it — yet
/// accepts every journal digest with every proof blob.
contract AlwaysAcceptSignerVerifier is IZkVerifier {
    bytes32 public constant programVKey = keccak256("looks-like-the-real-signer-guest");

    function verify(bytes calldata, bytes32) external view {}
}

contract CanonicalRejectingSignerVerifier is IZkVerifier {
    bytes32 public constant programVKey = keccak256("canonical-signer-guest");

    function verify(bytes calldata, bytes32) external pure {
        revert("canonical verifier rejected proof");
    }
}

/// AUDIT regression — permissionless creation can select signer policy, but the proof gate is the
/// wrapper's immutable canonical verifier/vkey pair.
contract ZkJournalUnpinnedSignerVerifierTest is TrustgraphsFactoryBase {
    GovernedTrustgraphsFactory internal governedFactory;
    GnosisSafe internal safeSingleton;
    GnosisSafeProxyFactory internal safeFactory;
    CanonicalRejectingSignerVerifier internal canonicalVerifier;

    address internal creator = address(0xA11CE);
    address internal stranger = address(0xBADBAD);

    function setUp() public override {
        super.setUp();
        safeSingleton = new GnosisSafe();
        safeFactory = new GnosisSafeProxyFactory();
        canonicalVerifier = new CanonicalRejectingSignerVerifier();
        governedFactory = new GovernedTrustgraphsFactory(
            factory,
            safeFactory,
            address(safeSingleton),
            new GovernedAuthorityDeployer(),
            new SignerSyncModuleDeployer(),
            new MerkleGovModuleDeployer(),
            canonicalVerifier,
            canonicalVerifier.programVKey()
        );
    }

    function test_CallerCannotInstallAnAttackerSuppliedSignerVerifier() public {
        AlwaysAcceptSignerVerifier fake = new AlwaysAcceptSignerVerifier();

        GovernedTrustgraphsFactory.SignerSyncConfig memory signerConfig = GovernedTrustgraphsFactory.SignerSyncConfig({
            enabled: true, topN: 5, minThreshold: 2, targetThresholdBps: 5000
        });

        TrustgraphsFactory.CreateArgs memory args = _args("looks-governed");
        vm.prank(creator);
        (bytes32 instanceId,,, address snapshot) =
            governedFactory.createGovernedInstance(args, GovernedTrustgraphsFactory.InitialPolicy(0, 0), signerConfig);

        GovernedTrustgraphsFactory.Authority memory authority = governedFactory.authorityOf(instanceId);
        SignerSyncZkModule signer = SignerSyncZkModule(authority.signerSyncModule);
        address safe = authority.safe;

        assertEq(
            address(signer.zkVerifier()), address(canonicalVerifier), "wrapper must install its immutable verifier"
        );
        assertTrue(
            address(signer.zkVerifier()) != address(fake), "caller-controlled verifier must be ignored by design"
        );
        assertTrue(GnosisSafe(payable(safe)).isModuleEnabled(address(signer)), "module is live on the Safe");
        // The Safe holds the snapshot's constitutional authority.
        assertTrue(
            MerkleSnapshot(snapshot).hasRole(MerkleSnapshot(snapshot).CONSTITUTIONAL_ROLE(), safe),
            "Safe owns the truth-defining knobs"
        );

        MerkleSnapshot scoreSnapshot = MerkleSnapshot(snapshot);
        vm.roll(uint256(scoreSnapshot.epochOriginBlock()) + EPOCH_FLOOR);
        uint256 checkpointId = scoreSnapshot.trigger();
        bytes32 activityAcc = keccak256("attacker-compatible activity");
        vm.mockCall(
            authority.governanceModule,
            abi.encodeWithSelector(bytes4(keccak256("activityAccumulator()"))),
            abi.encode(activityAcc)
        );
        vm.mockCall(
            authority.governanceModule,
            abi.encodeWithSelector(bytes4(keccak256("activityCount()"))),
            abi.encode(uint64(2))
        );
        vm.mockCall(
            authority.governanceModule,
            abi.encodeWithSelector(MerkleGovModule.getActivityCheckpoint.selector, uint256(0)),
            abi.encode(MerkleGovModule.ActivityCheckpoint(activityAcc, 2, uint64(block.number)))
        );

        // A COMPLETE STRANGER — not the creator, not a role holder — rotates the Safe's owner set
        // to an address of their choosing, with `hex"00"` as the "proof".
        address[] memory desired = new address[](1);
        desired[0] = stranger;

        vm.prank(stranger);
        vm.expectRevert(bytes("canonical verifier rejected proof"));
        signer.submitSignerProof(checkpointId, 0, desired, 1, hex"00");

        assertFalse(GnosisSafe(payable(safe)).isOwner(stranger), "attacker proof must not alter owners");
        assertTrue(GnosisSafe(payable(safe)).isOwner(creator), "the real member remains owner");
    }
}
